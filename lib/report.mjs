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
import { DRIFT_MIN_N, HOLDOUT_TRAIN, VERDICT_ROUNDS, baselineVerdict, median, quantile, scoreBaselines, scoreConformal, scoreCost, scoreDrift, scoreGroups, scoreRuns, wilson } from './stats.mjs'

const DAY = 86_400_000
const TYPE_ROWS = 20
const TOOL_ROWS = 10
const MIN_SCORED = 5
/** Under this many scored runs a table of types, shapes or cost says too few to say instead of a rate. */
const MIN_RATE = 30

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
 * A hit rate with its 95% Wilson interval, `83% (44-97%)`; `too few to say`
 * under MIN_RATE runs when `guard` is set (the tables of types, shapes and cost).
 * @param {number | null} coverage
 * @param {number} n scored runs
 * @param {boolean} [guard]
 */
const rate = (coverage, n, guard = false) => {
  if (coverage === null || n === 0) return '-'
  if (guard && n < MIN_RATE) return 'too few to say'
  const ci = wilson(Math.round(coverage * n), n)
  return ci ? `${pct(coverage)} (${pct(ci.lo)} to ${pct(ci.hi)})` : pct(coverage)
}
/** A ratio as `x1.6`, or `-` when there is none. */
const times = (/** @type {number | null} */ x) => (x === null ? '-' : `x${x.toFixed(1)}`)
/** A typical miss (|log ratio|) as `x1.6`. */
const miss = (/** @type {number | null} */ e) => (e === null ? '-' : times(Math.exp(e)))
/** The share of a total that its largest 5% of values make up; null for no total. */
function tailShare(/** @type {readonly number[]} */ values) {
  const v = [...values].sort((a, b) => b - a)
  const total = sum(v)
  return total > 0 ? sum(v.slice(0, Math.ceil(v.length * 0.05))) / total : null
}

/** A relative gap to one decimal, `0.2%`, so a near tie does not read as 0%. */
const gap = (/** @type {number} */ x) => `${(x * 100).toFixed(1)}%`

/**
 * The computed one-line verdict on the matcher against the per-type median,
 * for time or cost.
 * @param {ReturnType<typeof baselineVerdict>} v
 * @param {string} what `time` or `cost`
 * @param {(x: number) => string} fmt the score's unit
 * @returns {string}
 */
function verdictLine(v, what, fmt) {
  const why =
    v.ratio === null || v.matcherScore === null || v.typeScore === null
      ? 'nothing could be held out'
      : `mean interval score ${fmt(v.matcherScore)} against ${fmt(v.typeScore)}, ${v.ratio <= 1 ? `${gap(1 - v.ratio)} lower` : `${gap(v.ratio - 1)} higher`}; the matcher scored lower in ${v.winRate === null ? '-' : pct(v.winRate)} of ${VERDICT_ROUNDS} resamples of the ${v.n} held-out runs, where the two slow figures held ${v.matcherCoverage === null ? '-' : pct(v.matcherCoverage)} and ${v.typeCoverage === null ? '-' : pct(v.typeCoverage)} of the time`
  return `**Verdict on ${what}: the matcher beats the per-type median out of sample, by interval score: ${v.verdict}** (${why}).`
}

/**
 * @typedef {ReturnType<typeof summarizeRuns>[number]} Run
 */

/**
 * Runs added up: run time, the priced turns' cost, and how many turns had a
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
      'Dollars at API prices: what the same work would cost on the API, not what was billed. Times are run time, the clock the band counts: the time the main loop or any of its subagents was working, background ones included and parallel ones counted once, with waiting on you and machine sleep left out.',
    '',
  )
  const fellBack = sum(runs.map(r => r.fellBack ?? 0))
  if (fellBack > 0) {
    out.push(
      `${fellBack} row${fellBack === 1 ? '' : 's'} could not be placed on the clock (logged before the recorder kept a turn's own start, with a wait on you that began before the engine's turn time), so ${fellBack === 1 ? 'it adds its' : 'each adds its'} own stored time instead, taken as overlapping nothing else in its run. A backfilled row is placed by its timestamps, less any stretch of over 10 minutes with nothing in flight.`,
      '',
    )
  }
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
  out.push(table(['Period', 'Runs', 'Run time', 'Cost'], [window('Last 7 days', 7), window('Last 30 days', 30), ['All time', all.runs, fmtDur(all.ms), costOf(all)]]), '')

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
    table([head, 'Runs', 'Run time', 'Cost'], groups.map(g => [g.key, g.runs.length, fmtDur(totalOf(g.runs).ms), costOf(totalOf(g.runs))]))
  out.push('## By model', '', simple(groupBy(runs, r => modelKey(r.model) ?? 'unknown'), 'Model'), '')
  out.push('## By project', '', simple(groupBy(runs, r => r.project ?? '(none)'), 'Project'), '')
  const jobs = groupBy(runs.filter(r => r.job), r => r.job ?? '')
  out.push('## By job', '')
  if (jobs.length === 0) out.push('No runs were tagged with a job. Set one with /eta job <name>.', '')
  else {
    out.push(
      table(
        ['Job', 'Runs', 'Run time', 'Cost', 'First', 'Last'],
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

  // Where the time went. The run time splits into the main loop's own (its tools, less the time held on you,
  // capped at it, and the rest the model's) and the time only subagents worked while the main loop was idle.
  /** @type {Map<string, number>} */
  const toolMsByRun = new Map()
  for (const r of unique) {
    if (r.agentId) continue
    toolMsByRun.set(r.runId, (toolMsByRun.get(r.runId) ?? 0) + Math.max(0, (r.toolMs ?? 0) - (r.waitMs ?? 0)))
  }
  const mainMs = sum(runs.map(r => Math.min(r.agentMs, r.mainMs ?? r.agentMs)))
  const toolMs = sum(runs.map(r => Math.min(r.agentMs, r.mainMs ?? r.agentMs, toolMsByRun.get(r.runId) ?? 0)))
  const modelMs = Math.max(0, mainMs - toolMs)
  const aloneMs = Math.max(0, all.ms - mainMs)
  const waitMs = sum(runs.map(r => r.waitMs))
  const sleepMs = sum(runs.map(r => r.sleepMs))
  const wall = all.ms + waitMs + sleepMs
  const share = (/** @type {number} */ ms) => (wall > 0 ? pct(ms / wall) : '-')
  out.push(
    '## Where the time went',
    '',
    'The first three parts add up to the run time: the main loop working, then the time only its subagents worked (the main loop done or idle, a background agent still going). Subagent time while the main loop also worked is in the main loop\'s parts, since the clock counts it once.',
    '',
    table(['Part', 'Time', 'Share'], [
      ['Main loop, the model working', fmtDur(modelMs), share(modelMs)],
      ['Main loop, tools', fmtDur(toolMs), share(toolMs)],
      ['Subagents alone', fmtDur(aloneMs), share(aloneMs)],
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
          rate(s.coverage, s.n, true),
          s.submitError === null ? '-' : `x${Math.exp(s.submitError).toFixed(1)}`,
          `x${s.factor.toFixed(2)}`,
          s.shown.n > 0 && s.shown.coverage !== null ? `${rate(s.shown.coverage, s.shown.n, true)} of ${s.shown.n}` : '-',
        ]),
      ),
      '',
    )
  }

  // Versus naive baselines: the same runs predicted four ways, from earlier runs only.
  const base = scoreBaselines(usable)
  const baseAll = base.all
  out.push('## Versus naive baselines', '')
  if (!baseAll || baseAll.n < MIN_SCORED) out.push(`Fewer than ${MIN_SCORED} runs can be compared yet.`, '')
  else {
    const names = { matcher: 'Matcher (uncorrected)', matcherCorrected: 'Matcher (corrected)', type: 'Per-type median and p80', global: 'Global median and p80' }
    out.push(verdictLine(baselineVerdict(baseAll), 'time', fmtDur), '')
    const costAll = scoreBaselines(usable, { measure: 'cost' }).all
    if (costAll && costAll.n >= MIN_SCORED) out.push(verdictLine(baselineVerdict(costAll), 'cost', fmtUsd), '')
    const hold = baseAll.holdout
    const worst = hold ? tailShare(hold.predictors.matcher.scores) : null
    out.push(
      'Yes or no needs a mean score at least 5% lower that stays lower in at least 90% of the resamples, and at least 100 held-out runs; otherwise unclear. ' +
        "A run's interval score is its slow figure plus five times any overrun past it, so a figure set too low pays for every overrun and one set too high pays for its width: each figure is scored as it stands, with no coverage matching." +
        (worst === null ? '' : ` Long overruns weigh the most: the worst 5% of the held-out runs make up ${pct(worst)} of the matcher's time score.`),
      '',
    )
    if (hold) {
      out.push(
        `Held out, the verdict's basis: the last ${pct(1 - HOLDOUT_TRAIN)} of the runs by start time (${hold.n} runs), each slow figure as it stands:`,
        '',
        table(
          ['Predictor', 'Finished under slow', 'Median slow', 'Mean interval score'],
          Object.entries(names).map(([name, label]) => {
            const p = hold.predictors[/** @type {keyof typeof names} */ (name)]
            return [label, rate(p.raw.coverage, hold.n), p.raw.slowMs === null ? '-' : fmtDur(p.raw.slowMs), p.score === null ? '-' : fmtDur(p.score)]
          }),
        ),
        '',
      )
    }
    out.push(
      `In sample, not the verdict's basis: the same ${baseAll.n} runs, each predicted from only the runs that ended before it started. "At matched coverage" scales a predictor's slow figure until it holds as often as the uncorrected matcher's on these same runs, a fit that favours the baselines.`,
      '',
      table(
        ['Predictor', 'Finished under slow', 'Slow / usual', 'Median slow', 'Typical miss', 'Slow / usual at matched coverage (in sample)', 'Median slow at matched coverage (in sample)'],
        Object.entries(names).map(([name, label]) => {
          const p = baseAll.predictors[/** @type {keyof typeof names} */ (name)]
          return [label, rate(p.coverage, baseAll.n), times(p.spread), p.slowMs === null ? '-' : fmtDur(p.slowMs), miss(p.error), times(p.equal.spread), p.equal.slowMs === null ? '-' : fmtDur(p.equal.slowMs)]
        }),
      ),
      '',
    )
    const byType = Object.entries(base).filter(([k, b]) => k !== 'all' && b.n >= MIN_SCORED).sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])).slice(0, TYPE_ROWS)
    if (byType.length > 0) {
      out.push(
        'Per task type, in sample: slow / usual at matched coverage (matcher, per-type, global) and the typical miss of the usual figure (same order):',
        '',
        table(
          ['Task type', 'Runs', 'Matcher', 'Per-type', 'Global', 'Miss: matcher', 'Miss: per-type', 'Miss: global'],
          byType.map(([type, b]) => [type, b.n, times(b.predictors.matcher.equal.spread), times(b.predictors.type.equal.spread), times(b.predictors.global.equal.spread), miss(b.predictors.matcher.error), miss(b.predictors.type.error), miss(b.predictors.global.error)]),
        ),
        '',
      )
    }
  }

  // Conformal: a finite-sample correction of the slow figure against the one in use, on the same held-out runs.
  const conf = scoreConformal(usable)
  out.push('## Conformal slow figure', '')
  if (!conf || conf.n < MIN_SCORED) out.push(`Fewer than ${MIN_SCORED} runs are held out yet.`, '')
  else {
    const dur = (/** @type {number | null} */ ms) => (ms === null ? '-' : fmtDur(ms))
    out.push(
      `Split-conformal calibration of the slow figure against the correction in use, on the same ${conf.n} held-out runs. Both multiply the matcher's slow figure by a factor fitted on only the runs of the task type that ended before the run started: the one in use is the 80th percentile, interpolated, of actual over slow across all of them (the baseline table's corrected matcher fits on the latest 50 instead); conformal takes the ceil(0.8 (n + 1))-th smallest of the latest ${conf.recent}, which promises at least 80% while recent runs are like the next one.`,
      '',
      table(
        ['Slow figure', 'Finished under slow (target 80%)', 'Median slow', 'Mean interval score'],
        [
          ['Correction in use', rate(conf.fitted.coverage, conf.n), dur(conf.fitted.slowMs), dur(conf.fitted.score)],
          [`Conformal, latest ${conf.recent}`, rate(conf.conformal.coverage, conf.n), dur(conf.conformal.slowMs), dur(conf.conformal.score)],
        ],
      ),
      '',
      conf.better
        ? 'Conformal passes the bar for live use on these runs (coverage closer to 80% with a median slow figure no wider); the live estimate keeps the correction in use until it is switched in code.'
        : 'The live estimate keeps the correction in use: conformal did not hold closer to 80% with a median slow figure no wider on these runs, so it stays an evaluated option.',
      '',
    )
  }

  // Drift: does the slow figure hold as often in every month and on every model?
  const drift = scoreDrift(usable)
  out.push('## Drift', '')
  if (drift.byMonth.length === 0) out.push('No runs could be scored yet.', '')
  else {
    const driftRows = (/** @type {string} */ axis, /** @type {typeof drift.byMonth} */ groups) => groups.map(g => [axis, g.key, g.n, rate(g.coverage, g.n, true)])
    out.push(
      table(['By', 'Group', 'Scored runs', 'Finished under slow (target 80%)'], [...driftRows('month', drift.byMonth), ...driftRows('main model', drift.byModel)]),
      '',
      drift.drift === 'yes'
        ? `Drift exists: two groups of at least ${DRIFT_MIN_N} runs have coverage intervals that do not overlap.`
        : drift.drift === 'no'
          ? `No drift seen: no two groups of at least ${DRIFT_MIN_N} runs have coverage intervals that are apart.`
          : `Unclear: fewer than two months or models have ${DRIFT_MIN_N} scored runs to compare.`,
      '',
    )
  }

  // Cost: the same replay on dollars.
  const costs = scoreCost(usable)
  const costRows = Object.entries(costs).filter(([, s]) => s.n >= MIN_SCORED).sort((a, b) => (a[0] === 'all' ? -1 : b[0] === 'all' ? 1 : b[1].n - a[1].n || a[0].localeCompare(b[0]))).slice(0, TYPE_ROWS + 1)
  out.push('## Cost accuracy', '')
  if (costRows.length === 0) out.push(`No task type has ${MIN_SCORED} runs with a whole cost yet.`, '')
  else {
    out.push(
      table(
        ['Task type', 'Scored runs', 'Finished under slow cost (target 80%)', 'Typical miss'],
        costRows.map(([type, s]) => [type === 'all' ? 'all types' : type, s.n, rate(s.coverage, s.n, true), miss(s.error)]),
      ),
      '',
    )
  }

  // Freeform by shape: the shape is known after the second request, but the replay estimates at submit.
  const shapeScores = Object.entries(scoreGroups(usable, r => (r.taskType === 'freeform' ? ((/** @type {any} */ (r)).shape ?? 'answer') : null))).filter(([, s]) => s.n >= MIN_SCORED).sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
  if (shapeScores.length > 0) {
    out.push(
      '## Freeform accuracy by shape',
      '',
      table(
        ['Shape', 'Scored runs', 'Finished under slow (target 80%)', 'Typical miss'],
        shapeScores.map(([shape, s]) => [shape, s.n, rate(s.coverage, s.n, true), miss(s.error)]),
      ),
      '',
    )
  }

  out.push(
    '## How to read this',
    '',
    'Usual is the median run time of a task type and slow is the 80th percentile; a well-calibrated slow figure is beaten by 8 runs in 10.',
    'Accuracy replays every run against only the runs that ended before it started, with no correction, so it is scored from the first day; "typical miss" x1.6 means the usual figure is off by that factor, either way, in the median run.',
    '"Versus naive baselines" asks whether the matcher earns its keep against a predictor that only knows the type median or the global 80th percentile, scored on the same runs. The verdict reads the held-out interval score, which rewards a slow figure that is narrow and still holds; the in-sample tables at matched coverage are background. Hit rates carry a 95% interval, and a table of types, shapes or cost says too few to say under 30 runs. Cost, drift, the conformal check and the freeform shape table use the same replay.',
    '"As shown live" is how often the estimate a live run actually displayed (after the correction) held; it fills in as live runs accumulate.',
    '',
  )
  return out.join('\n')
}
