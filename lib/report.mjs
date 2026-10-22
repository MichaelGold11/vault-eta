// @ts-check
// The report: one markdown note built from every logged row, all time. Pure
// (rows in, text out), so the /eta report command and scripts/report.mjs make
// the same note. It holds counts, times, dollars at API prices, task types,
// projects, jobs, tool names and the first words of Bash commands the log
// already keeps; no prompt text, file contents or full commands exist in the
// log to leak.

import { dedupeRuns, summarizeRuns } from './aggregate.mjs'
import { fmtCost, fmtDur, fmtUsd } from './format.mjs'
import { familyOf, modelKey } from './price.mjs'
import { median, quantile, scoreRuns } from './stats.mjs'

const DAY = 86_400_000
const TYPE_ROWS = 20
const TOOL_ROWS = 10
const MIN_SCORED = 5

/**
 * @param {number} ms
 * @returns {string} the local calendar date, YYYY-MM-DD
 */
function dateOf(ms) {
  const d = new Date(ms)
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** A table cell that cannot break the row. */
const cell = (/** @type {unknown} */ v) => String(v).replace(/\|/g, '/').replace(/\s+/g, ' ').trim()

/**
 * @param {string[]} head
 * @param {unknown[][]} rows
 * @returns {string}
 */
function table(head, rows) {
  const line = (/** @type {unknown[]} */ cells) => `| ${cells.map(cell).join(' | ')} |`
  return [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n')
}

const sum = (/** @type {number[]} */ list) => list.reduce((s, n) => s + n, 0)
const pct = (/** @type {number} */ x) => `${Math.round(x * 100)}%`

/**
 * @typedef {ReturnType<typeof summarizeRuns>[number]} Run
 */

/**
 * Runs added up: agent time, the priced turns' cost, and how many turns had a
 * price and how many had none.
 * @param {Run[]} runs
 * @returns {{ runs: number, ms: number, usd: number, priced: number, unpriced: number }}
 */
function totalOf(runs) {
  const unpriced = sum(runs.map(r => r.unpricedTurns ?? 0))
  return { runs: runs.length, ms: sum(runs.map(r => r.agentMs)), usd: sum(runs.map(r => r.usd ?? 0)), priced: sum(runs.map(r => r.turns ?? 1)) - unpriced, unpriced }
}

/** A total's cost cell: `--` with nothing priced, `$1.20+` with only part. */
const costOf = (/** @type {{ usd: number, priced: number, unpriced: number }} */ t) => fmtCost(t.usd, t.priced, t.unpriced)

/**
 * Groups of runs by a key, biggest first (more runs, then more cost).
 * @param {Run[]} runs
 * @param {(r: Run) => string} keyOf
 * @returns {Array<{ key: string, runs: Run[] }>}
 */
function groupBy(runs, keyOf) {
  /** @type {Map<string, Run[]>} */
  const map = new Map()
  for (const r of runs) {
    const k = keyOf(r)
    const list = map.get(k)
    if (list) list.push(r)
    else map.set(k, [r])
  }
  return [...map].map(([key, list]) => ({ key, runs: list })).sort((a, b) => b.runs.length - a.runs.length || totalOf(b.runs).usd - totalOf(a.runs).usd || a.key.localeCompare(b.key))
}

/**
 * The report as markdown.
 * @param {ReadonlyArray<any>} rows log rows, any kind; session rows are ignored
 * @param {{ now: number, title?: string }} options
 * @returns {string}
 */
export function buildReport(rows, options) {
  const now = options.now
  const turns = rows.filter(r => r && r.kind !== 'session' && typeof r.runId === 'string')
  const runs = summarizeRuns(turns)
  const today = dateOf(now)
  const title = options.title ?? 'vault-eta report'
  const front = ['---', 'type: reference', `title: ${title}`, `created: ${today}`, `updated: ${today}`, 'tags: [vault-eta, report]', 'generated: true', '---', '']
  if (runs.length === 0) {
    return [...front, `# ${title}`, '', `Generated ${today}. No runs are logged yet.`, ''].join('\n')
  }

  const machines = [...new Set(turns.map(r => r.machineId).filter((m) => typeof m === 'string'))].sort()
  const first = Math.min(...runs.map(r => r.startedAt))
  const last = Math.max(...runs.map(r => r.startedAt))
  /** @type {string[]} */
  const out = [...front, `# ${title}`, '']
  out.push(
    `Generated ${today}. ${runs.length} runs from ${dateOf(first)} to ${dateOf(last)}, ${machines.length} machine${machines.length === 1 ? '' : 's'} (${machines.join(', ') || 'unknown'}). ` +
      'Dollars at API prices: what the same work would cost on the API, not what was billed. Times are agent time: waiting on you and machine sleep are left out.',
    '',
  )
  const unpricedTurns = sum(runs.map(r => r.unpricedTurns ?? 0))
  if (unpricedTurns > 0) {
    out.push(
      `${unpricedTurns} turn${unpricedTurns === 1 ? '' : 's'} ran on a model missing from the price table (lib/price.mjs), so ${unpricedTurns === 1 ? 'its' : 'their'} cost is left out: a cost marked + is missing some, and -- has none priced.`,
      '',
    )
  }

  // Totals
  out.push('## Totals', '')
  const window = (/** @type {string} */ label, /** @type {number} */ days) => {
    const t = totalOf(runs.filter(r => r.startedAt >= now - days * DAY))
    return [label, t.runs, fmtDur(t.ms), costOf(t)]
  }
  const all = totalOf(runs)
  out.push(table(['Period', 'Runs', 'Agent time', 'Cost'], [window('Last 7 days', 7), window('Last 30 days', 30), ['All time', all.runs, fmtDur(all.ms), costOf(all)]]), '')

  // By task type: usual and slow from finished runs with time on the clock.
  out.push('## By task type', '')
  const types = groupBy(runs, r => r.taskType)
  const typeRow = (/** @type {string} */ label, /** @type {Run[]} */ list) => {
    const times = list.filter(r => r.outcome === 'finished' && r.agentMs > 0).map(r => r.agentMs)
    const usual = median(times)
    const slow = quantile(times, 0.8)
    // the median over runs priced whole
    const costs = list.filter(r => typeof r.usd === 'number' && !(r.unpricedTurns > 0)).map(r => /** @type {number} */ (r.usd))
    const mid = median(costs)
    return [label, list.length, usual === null ? '-' : fmtDur(usual), slow === null ? '-' : fmtDur(slow), mid === null ? '-' : fmtUsd(mid), costOf(totalOf(list))]
  }
  const shown = types.slice(0, TYPE_ROWS).map(g => typeRow(g.key, g.runs))
  const rest = types.slice(TYPE_ROWS)
  if (rest.length > 0) shown.push(typeRow(`other (${rest.length} types)`, rest.flatMap(g => g.runs)))
  out.push(table(['Task type', 'Runs', 'Usual', 'Slow', 'Median cost', 'Total cost'], shown), '')

  // By shape: what the run did in its first two model requests (the matching key from the third on).
  const shapes = groupBy(runs, r => r.shape ?? 'answer')
  out.push('## By shape', '', 'What a run did in its first two model requests: answer (no tools), read, shell (commands), edit (files) or agents. The estimate matches on it from the third request.', '')
  out.push(table(['Shape', 'Runs', 'Usual', 'Slow', 'Median cost', 'Total cost'], shapes.map(g => typeRow(g.key, g.runs))), '')

  // By model, project, job
  const simple = (/** @type {Array<{ key: string, runs: Run[] }>} */ groups, /** @type {string} */ head) =>
    table([head, 'Runs', 'Agent time', 'Cost'], groups.map(g => [g.key, g.runs.length, fmtDur(totalOf(g.runs).ms), costOf(totalOf(g.runs))]))
  out.push('## By model', '', simple(groupBy(runs, r => modelKey(r.model) ?? 'unknown'), 'Model'), '')
  out.push('## By project', '', simple(groupBy(runs, r => r.project ?? '(none)'), 'Project'), '')
  const jobs = groupBy(runs.filter(r => r.job), r => r.job ?? '')
  out.push('## By job', '')
  if (jobs.length === 0) out.push('No runs were tagged with a job. Set one with /eta job <name>.', '')
  else {
    out.push(
      table(
        ['Job', 'Runs', 'Agent time', 'Cost', 'First', 'Last'],
        jobs.map(g => [g.key, g.runs.length, fmtDur(totalOf(g.runs).ms), costOf(totalOf(g.runs)), dateOf(Math.min(...g.runs.map(r => r.startedAt))), dateOf(Math.max(...g.runs.map(r => r.startedAt)))]),
      ),
      '',
    )
  }

  // Who did the work: every row is one loop's turn.
  const unique = /** @type {any[]} */ (dedupeRuns(turns))
  /** @type {Map<string, { turns: number, ms: number, usd: number, priced: number, unpriced: number }>} */
  const who = new Map()
  for (const r of unique) {
    const label = `${r.agentId ? (r.agentType ?? 'agent') : 'main thread'} (${familyOf(r.model)})`
    const w = who.get(label) ?? { turns: 0, ms: 0, usd: 0, priced: 0, unpriced: 0 }
    w.turns += 1
    w.ms += (r.agentId ? r.ms : (r.agentMs ?? r.ms)) ?? 0
    w.usd += r.usd ?? 0
    if (typeof r.usd === 'number') w.priced += 1
    else w.unpriced += 1
    who.set(label, w)
  }
  out.push(
    '## Who did the work',
    '',
    table(
      ['Loop', 'Turns', 'Time', 'Cost'],
      [...who].sort((a, b) => b[1].usd - a[1].usd).map(([label, w]) => [label, w.turns, fmtDur(w.ms), costOf(w)]),
    ),
    '',
  )

  // Where the time went. Tool time is the main loop's, less the time held on you, capped at the run's agent time.
  /** @type {Map<string, number>} */
  const toolMsByRun = new Map()
  for (const r of unique) {
    if (r.agentId) continue
    toolMsByRun.set(r.runId, (toolMsByRun.get(r.runId) ?? 0) + Math.max(0, (r.toolMs ?? 0) - (r.waitMs ?? 0)))
  }
  const toolMs = sum(runs.map(r => Math.min(r.agentMs, toolMsByRun.get(r.runId) ?? 0)))
  const agentMs = Math.max(0, all.ms - toolMs)
  const waitMs = sum(runs.map(r => r.waitMs))
  const sleepMs = sum(runs.map(r => r.sleepMs))
  const wall = all.ms + waitMs + sleepMs
  const share = (/** @type {number} */ ms) => (wall > 0 ? pct(ms / wall) : '-')
  out.push(
    '## Where the time went',
    '',
    table(['Part', 'Time', 'Share'], [
      ['Agent (the model working)', fmtDur(agentMs), share(agentMs)],
      ['Tools', fmtDur(toolMs), share(toolMs)],
      ['Waiting on you', fmtDur(waitMs), share(waitMs)],
      ['Machine asleep', fmtDur(sleepMs), share(sleepMs)],
    ]),
    '',
  )
  /** @type {Map<string, { calls: number, ms: number }>} */
  const heads = new Map()
  for (const r of unique) {
    for (const t of r.tools ?? []) {
      const name = String(t.name ?? 'tool')
      const head = name === 'Bash' && t.cmd ? `Bash ${String(t.cmd).slice(0, 40)}` : name
      const h = heads.get(head) ?? { calls: 0, ms: 0 }
      h.calls += 1
      h.ms += Math.max(0, (t.runMs ?? t.ms ?? 0) - (t.runMs === undefined ? (t.waitMs ?? 0) : 0))
      heads.set(head, h)
    }
  }
  out.push('Top tools by total time, all loops:', '')
  out.push(
    table(
      ['Tool', 'Calls', 'Total time', 'Mean'],
      [...heads].sort((a, b) => b[1].ms - a[1].ms).slice(0, TOOL_ROWS).map(([head, h]) => [head, h.calls, fmtDur(h.ms), fmtDur(h.ms / h.calls)]),
    ),
    '',
  )

  // Accuracy: every run replayed against only the runs that ended before it.
  const usable = runs.filter(r => r.outcome === 'finished' && r.agentMs > 0)
  const scores = scoreRuns(usable)
  const accurate = Object.entries(scores).filter(([, s]) => s.n >= MIN_SCORED).sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
  out.push('## Accuracy per task type', '')
  if (accurate.length === 0) out.push(`No task type has ${MIN_SCORED} scored runs yet.`, '')
  else {
    out.push(
      table(
        ['Task type', 'Scored runs', 'Finished under slow (target 80%)', 'Typical miss', 'Correction in use', 'As shown live'],
        accurate.map(([type, s]) => [
          type,
          s.n,
          s.coverage === null ? '-' : pct(s.coverage),
          s.submitError === null ? '-' : `x${Math.exp(s.submitError).toFixed(1)}`,
          `x${s.factor.toFixed(2)}`,
          s.shown.n > 0 && s.shown.coverage !== null ? `${pct(s.shown.coverage)} of ${s.shown.n}` : '-',
        ]),
      ),
      '',
    )
  }

  out.push(
    '## How to read this',
    '',
    'Usual is the median agent time of a task type and slow is the 80th percentile; a well-calibrated slow figure is beaten by 8 runs in 10.',
    'Accuracy replays every run against only the runs that ended before it started, with no correction, so it is scored from the first day; "typical miss" x1.6 means the usual figure is off by that factor, either way, in the median run.',
    '"As shown live" is how often the estimate a live run actually displayed (after the correction) held; it fills in as live runs accumulate.',
    '',
  )
  return out.join('\n')
}
