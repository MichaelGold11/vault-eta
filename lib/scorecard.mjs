// @ts-check
// The scorecard: a short, numbers-only summary of how well the estimate held,
// built to be pasted into an issue or a post. Pure (rows in, text out). It
// reads the same scores as the report (lib/stats.mjs) but prints only counts,
// rates and ratios, and the five shapes the estimate matches on. It never
// prints a task type, project, job, skill, tool, path, model, machine id or
// date of a run: nothing in a row is copied into the text.

import { summarizeRuns } from './aggregate.mjs'
import { fmtDur, fmtUsd } from './format.mjs'
import { DRIFT_MIN_N, VERDICT_ROUNDS, baselineVerdict, scoreBaselines, scoreCost, scoreDrift, scoreGroups, wilson } from './stats.mjs'

const DAY = 86_400_000
/** The scorecard's first line: it has no frontmatter, so it can be pasted as it is; the command overwrites only a file that starts with it. */
export const SCORECARD_MARK = '<!-- vault-eta scorecard, generated; numbers only -->'
/** Under this many scored runs a rate says too few to say. */
const MIN_RATE = 30
/** A shape row needs this many scored runs to be listed. */
const MIN_SCORED = 5
/** The shapes a run can have; anything else is counted as `answer`, so a stray value is never printed. */
const SHAPES = ['answer', 'read', 'shell', 'edit', 'agents']

const pct = (/** @type {number} */ x) => `${Math.round(x * 100)}%`
/** A hit rate with its 95% Wilson interval, `83% (44% to 97%)`. */
function rate(/** @type {number | null} */ coverage, /** @type {number} */ n) {
  if (coverage === null || n === 0) return '-'
  if (n < MIN_RATE) return 'too few to say'
  const ci = wilson(Math.round(coverage * n), n)
  return ci ? `${pct(coverage)} (${pct(ci.lo)} to ${pct(ci.hi)})` : pct(coverage)
}
/** A typical miss (|log ratio|) as `x1.6`. */
const miss = (/** @type {number | null} */ e) => (e === null ? '-' : `x${Math.exp(e).toFixed(1)}`)
const row = (/** @type {unknown[]} */ cells) => `| ${cells.join(' | ')} |`

/** The local calendar day of a time, counted in whole days, so two of them subtract to a span in calendar days. */
function dayIndex(/** @type {number} */ ms) {
  const d = new Date(ms)
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY)
}

/** The local calendar day of a time, as a number that sorts and counts distinct days. */
function dayOf(/** @type {number} */ ms) {
  const d = new Date(ms)
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()
}

/**
 * The scorecard as markdown.
 * @param {ReadonlyArray<any>} rows log rows, any kind; session rows are ignored
 * @returns {string}
 */
export function buildScorecard(rows) {
  const turns = rows.filter(r => r && r.kind !== 'session' && typeof r.runId === 'string')
  const runs = summarizeRuns(turns)
  /** @type {string[]} */
  const out = [SCORECARD_MARK, '# vault-eta scorecard', '']
  if (runs.length === 0) return [...out, 'No runs are logged yet.', ''].join('\n')

  const first = Math.min(...runs.map(r => r.startedAt))
  const last = Math.max(...runs.map(r => r.startedAt))
  const activeDays = new Set(runs.map(r => dayOf(r.startedAt))).size
  const spanDays = dayIndex(last) - dayIndex(first) + 1
  const usable = runs.filter(r => r.outcome === 'finished' && r.agentMs > 0)
  const scored = scoreGroups(usable, () => 'all').all?.n ?? 0
  const fellBack = runs.reduce((s, r) => s + (r.fellBack ?? 0), 0)
  out.push(
    `${runs.length} runs over ${spanDays} days (${activeDays} with runs); ${usable.length} finished, ${scored} scored (a run is scored only when enough earlier runs exist to predict it). Each run is predicted from only the runs that ended before it started. ` +
      'A run takes as long as the main loop or any of its subagents worked, parallel ones counted once, with waits on you and machine sleep left out.' +
      (fellBack > 0 ? ` ${fellBack} logged row${fellBack === 1 ? '' : 's'} could not be placed on that clock and count${fellBack === 1 ? 's' : ''} ${fellBack === 1 ? 'its' : 'their'} own stored time.` : ''),
    '',
  )

  out.push(
    '## Time estimate',
    '',
    "Finished under the slow figure (target 80%, with a 95% interval) and the typical miss of the usual figure, at submit: each estimate knows only the task type and project the run's estimate at submit had (its slash command, and the skills and folders of its first two requests), as the live one did.",
    '',
  )
  const shapeKey = (/** @type {any} */ r) => (SHAPES.includes(r.shape) ? r.shape : 'answer')
  const all = scoreGroups(usable, () => 'all').all
  const byShape = scoreGroups(usable, shapeKey)
  const lines = [row(['Shape', 'Scored runs', 'Finished under slow', 'Typical miss']), row(['---', '---', '---', '---'])]
  for (const shape of SHAPES) {
    const s = byShape[shape]
    if (s && s.n >= MIN_SCORED) lines.push(row([shape, s.n, rate(s.coverage, s.n), miss(s.error)]))
  }
  lines.push(row(['all runs', all?.n ?? 0, all ? rate(all.coverage, all.n) : '-', all ? miss(all.error) : '-']))
  out.push(...lines, '')
  const known = scoreGroups(usable, () => 'all', { labels: 'final' }).all
  if (known && known.n >= MIN_SCORED) {
    out.push(
      `Once the labels are known (each run's own task type and project, which only the finished run has, so no estimate at submit does): ${known.n} scored runs, finished under slow ${rate(known.coverage, known.n)}, typical miss ${miss(known.error)}.`,
      '',
    )
  }

  out.push('## Cost estimate', '')
  const cost = scoreCost(usable).all
  if (!cost || cost.n < MIN_SCORED) out.push('Too few runs with a whole cost to score yet.', '')
  else out.push(`${cost.n} runs with a whole cost: finished under the slow cost ${rate(cost.coverage, cost.n)}, typical miss ${miss(cost.error)}. Dollars at API prices.`, '')

  out.push('## Against a per-type median', '')
  const base = scoreBaselines(usable).all
  if (!base || base.n < MIN_SCORED) out.push('Too few runs to compare yet.', '')
  else {
    /** One measure's verdict: both mean interval scores and how often the matcher's was lower over the resamples. */
    const line = (/** @type {string} */ what, /** @type {ReturnType<typeof baselineVerdict>} */ v, /** @type {(x: number) => string} */ fmt) => {
      const gap =
        v.ratio === null || v.matcherScore === null || v.typeScore === null
          ? 'nothing could be held out'
          : `mean interval score ${fmt(v.matcherScore)} against ${fmt(v.typeScore)}, ${(Math.abs(1 - v.ratio) * 100).toFixed(1)}% ${v.ratio <= 1 ? 'lower' : 'higher'}, lower in ${v.winRate === null ? '-' : pct(v.winRate)} of ${VERDICT_ROUNDS} resamples`
      return `Does the matcher beat the per-type median on ${what}, out of sample, by interval score? **${v.verdict}** (${gap}; ${v.n} runs held out).`
    }
    out.push(line('time', baselineVerdict(base), fmtDur), '')
    const cost = scoreBaselines(usable, { measure: 'cost' }).all
    if (cost && cost.n >= MIN_SCORED) out.push(line('cost', baselineVerdict(cost), fmtUsd), '')
    out.push("A run's interval score is its slow figure plus five times any overrun past it. Yes or no needs a mean score at least 5% lower that stays lower in at least 90% of the resamples, and at least 100 held-out runs.", '')
  }

  out.push('## Drift', '')
  const drift = scoreDrift(usable).drift
  const rule =
    drift === 'yes'
      ? `two groups of at least ${DRIFT_MIN_N} runs have coverage intervals that do not overlap`
      : drift === 'no'
        ? `no two groups of at least ${DRIFT_MIN_N} runs have coverage intervals that are apart`
        : `fewer than two months or two models have ${DRIFT_MIN_N} scored runs to compare`
  out.push(`Has the slow figure's hit rate shifted between months or between models? **${drift === 'unclear' ? 'too few runs to say' : drift}** (${rule}).`, '')
  return out.join('\n')
}
