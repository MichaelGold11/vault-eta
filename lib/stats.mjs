// @ts-check
// Plain statistics over past runs: no model calls, no tokens. Matching with
// fallback, the usual (median) and slow (p80) figures, the remaining time
// given how long a run has gone (and while subagents are going), progress from
// steps and task lists, today's model speed, and the self-score that widens or
// tightens the slow figure.

/**
 * @typedef {{ taskType: string, project: string | null, model: string | null, effort?: string | number | null, promptChars?: number, size?: string, shape?: string | null, prevProject?: string | null, origin?: string, agentMs: number, usd: number | null, endedAt: number, mainSteps?: number, submitTaskType?: string, submitProject?: string | null }} PastRun
 * `taskType` and `project` are the run's own labels, known once it has done
 * its work; `submitTaskType` and `submitProject` are the ones its estimate at
 * submit knew (lib/aggregate summarizeRuns gives every logged run both).
 * @typedef {{ taskType: string, project?: string | null, model?: string | null, effort?: string | number | null, promptChars?: number, size?: string, shape?: string | null, prevProject?: string | null, origin?: string }} RunQuery
 * @typedef {{ name: string, keys: readonly string[], min?: number }} Level
 */

/**
 * The q-quantile by linear interpolation between order statistics; null for
 * no values.
 * @param {readonly number[]} values
 * @param {number} q
 * @returns {number | null}
 */
export function quantile(values, q) {
  const v = values.filter(Number.isFinite).slice().sort((a, b) => a - b)
  if (v.length === 0) return null
  const pos = Math.min(1, Math.max(0, q)) * (v.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  const a = v[lo] ?? 0
  const b = v[hi] ?? a
  return a + (b - a) * (pos - lo)
}

/**
 * @param {readonly number[]} values
 * @returns {number | null}
 */
export function median(values) {
  return quantile(values, 0.5)
}

/** Keys a query may not know yet; the others always match (an absent one means none). */
/**
 * The Wilson score interval of a hit rate: `hits` out of `n`, at 95% unless
 * `z` says otherwise. It stays inside 0 to 1 and is honest at small n, where
 * a plain percentage is not.
 * @param {number} hits
 * @param {number} n
 * @param {number} [z]
 * @returns {{ lo: number, hi: number } | null} null when n is 0
 */
export function wilson(hits, n, z = 1.96) {
  if (!(n > 0)) return null
  const p = hits / n
  const z2 = z * z
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n)
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n)
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) }
}

const OPTIONAL_KEYS = new Set(['project', 'shape'])

/**
 * The match levels, most specific first. A level is skipped while the query
 * does not know one of its optional keys yet (project before a folder is
 * touched, shape before the run's second request has ended): not knowing is
 * not the same as "none", so it never matches runs that had none. The shape levels
 * ask for 10 matches, not 5: a thin group's median is noisier than the
 * coarser group it would replace.
 * @type {readonly Level[]}
 */
export const LEVELS = [
  { name: 'type+project+shape+model', keys: ['taskType', 'project', 'shape', 'model'], min: 10 },
  { name: 'type+project+shape', keys: ['taskType', 'project', 'shape'], min: 10 },
  { name: 'type+shape+model', keys: ['taskType', 'shape', 'model'], min: 10 },
  { name: 'type+shape', keys: ['taskType', 'shape'], min: 10 },
  { name: 'type+project+model', keys: ['taskType', 'project', 'model'] },
  { name: 'type+project', keys: ['taskType', 'project'] },
  { name: 'type+model', keys: ['taskType', 'model'] },
  { name: 'type', keys: ['taskType'] },
]

/**
 * @typedef {{ level: string | null, runs: PastRun[], learning: { have: number, need: number } | null }} Match
 */

/**
 * How many past runs of its task type (the ones that ended last before it
 * started) the replay matches each run against. The live estimate takes the
 * newest 50 matches, so only a rare key reaches further back than this.
 */
export const REPLAY_WINDOW = 500

/** A prompt within this factor of the query's size, either way, counts as similar. */
const SIMILAR_FACTOR = 4

/**
 * Calls `fn` on the runs newest first (latest end first; runs that ended
 * together in the order given) until it returns true. A history already in
 * end order (`sortedAsc`, the replay's) is walked in place, with no copy or
 * sort.
 * @param {readonly PastRun[]} history
 * @param {boolean} sortedAsc
 * @param {(run: PastRun) => boolean} fn
 */
function eachNewest(history, sortedAsc, fn) {
  if (!sortedAsc) {
    for (const r of [...history].sort((a, b) => b.endedAt - a.endedAt)) if (fn(r)) return
    return
  }
  for (let i = history.length - 1; i >= 0; ) {
    const end = history[i]?.endedAt
    let j = i
    while (j > 0 && history[j - 1]?.endedAt === end) j--
    for (let k = j; k <= i; k++) if (fn(/** @type {PastRun} */ (history[k]))) return
    i = j - 1
  }
}

/** A run's agent time can be matched on: a finite number, not negative. */
const isUsableTime = (/** @type {unknown} */ ms) => typeof ms === 'number' && ms >= 0 && ms !== Infinity

/** The four keys a level matches on, read by name (fast), the rest by key. */
const NAMED_KEYS = new Set(['taskType', 'project', 'shape', 'model'])

/**
 * Past runs like this one: same task type, project, shape and model, falling
 * back to fewer of those while too few match. Within a level, the same effort and a
 * prompt within 4x the size are kept when they alone hold enough. The newest
 * `limit` are used. Under `minMatches` anywhere, `learning` says how many of
 * the task type there are.
 *
 * One pass per level over the runs newest first, stopping as soon as older
 * runs could not change the answer. `sortedAsc` says the history already
 * comes in end order (the replay's does), which saves a copy and a sort.
 * @param {readonly PastRun[]} history
 * @param {RunQuery} query
 * @param {{ minMatches?: number, limit?: number, levels?: readonly Level[], sortedAsc?: boolean }} [options]
 * @returns {Match}
 */
export function matchRuns(history, query, options = {}) {
  const minMatches = options.minMatches ?? 5
  const limit = options.limit ?? 50
  const levels = options.levels ?? LEVELS
  const sortedAsc = options.sortedAsc === true
  const runs = sortedAsc ? history : [...history].sort((a, b) => a.endedAt - b.endedAt)
  const keep = Math.max(limit, minMatches)
  const q = /** @type {any} */ (query)
  const effort = query.effort !== undefined && query.effort !== null ? query.effort : undefined
  const chars = query.promptChars ?? 0
  const hasEffort = effort !== undefined
  const hasChars = chars > 0
  // |log(c / chars)| <= log 4, as bounds on c
  const charsLow = chars / SIMILAR_FACTOR
  const charsHigh = chars * SIMILAR_FACTOR
  for (const level of levels) {
    if (!level.keys.every(k => !OPTIONAL_KEYS.has(k) || q[k] != null)) continue
    const byType = level.keys.includes('taskType')
    const byProject = level.keys.includes('project')
    const byShape = level.keys.includes('shape')
    const byModel = level.keys.includes('model')
    const wantType = q.taskType ?? null
    const wantProject = q.project ?? null
    const wantShape = q.shape ?? null
    const wantModel = q.model ?? null
    const other = level.keys.filter(k => !NAMED_KEYS.has(k))
    const otherWant = other.map(k => q[k] ?? null)
    const need = Math.max(level.min ?? 0, minMatches)
    /** @type {PastRun[]} */ const all = []
    /** @type {PastRun[]} */ const same = []
    /** @type {PastRun[]} */ const similar = []
    /** @type {PastRun[]} */ const sameSimilar = []
    let nAll = 0
    let nSame = 0
    let nSimilar = 0
    let nSameSimilar = 0
    eachNewest(runs, true, r => {
      if (!isUsableTime(r.agentMs)) return false
      if (byType && (r.taskType ?? null) !== wantType) return false
      if (byProject && (r.project ?? null) !== wantProject) return false
      if (byShape && (r.shape ?? null) !== wantShape) return false
      if (byModel && (r.model ?? null) !== wantModel) return false
      for (let i = 0; i < other.length; i++) if ((/** @type {any} */ (r)[/** @type {string} */ (other[i])] ?? null) !== otherWant[i]) return false
      nAll++
      if (all.length < keep) all.push(r)
      const isSame = hasEffort && r.effort === effort
      const c = r.promptChars ?? 0
      const isSimilar = hasChars && c > 0 && c >= charsLow && c <= charsHigh
      if (isSame) {
        nSame++
        if (same.length < keep) same.push(r)
      }
      if (isSimilar) {
        nSimilar++
        if (similar.length < keep) similar.push(r)
      }
      if (isSame && isSimilar) {
        nSameSimilar++
        if (sameSimilar.length < keep) sameSimilar.push(r)
      }
      // Enough of every set this level could pick from: older runs change nothing.
      return (
        nAll >= need &&
        all.length >= keep &&
        (!hasEffort || same.length >= keep) &&
        (!hasChars || (similar.length >= keep && (!hasEffort || sameSimilar.length >= keep)))
      )
    })
    if (nAll < need) continue
    let pool = all
    let near = similar
    let nNear = nSimilar
    if (hasEffort && nSame >= minMatches) {
      pool = same
      near = sameSimilar
      nNear = nSameSimilar
    }
    if (hasChars && nNear >= minMatches) pool = near
    return { level: level.name, runs: pool.slice(0, limit), learning: null }
  }
  /** @type {PastRun[]} */
  const sameType = []
  let have = 0
  eachNewest(runs, true, r => {
    if (!isUsableTime(r.agentMs) || r.taskType !== query.taskType) return false
    have++
    if (sameType.length < limit) sameType.push(r)
    return false
  })
  return { level: null, runs: sameType, learning: { have, need: minMatches } }
}

/**
 * @typedef {{ n: number, usualMs: number | null, slowMs: number | null, usualUsd: number | null, slowUsd: number | null, learning: { have: number, need: number } | null }} SubmitEstimate
 */

/**
 * The estimate shown at submit: usual and slow agent time and cost of the
 * matches. While learning, the figures are null and `learning` says how far.
 * @param {Match} match
 * @param {{ slowFactor?: number }} [options] the self-score's correction to the slow figure
 * @returns {SubmitEstimate}
 */
export function estimateAtSubmit(match, options = {}) {
  if (match.learning) return { n: match.runs.length, usualMs: null, slowMs: null, usualUsd: null, slowUsd: null, learning: match.learning }
  const factor = options.slowFactor ?? 1
  const ms = match.runs.map(r => r.agentMs)
  const usd = match.runs.map(r => r.usd).filter(/** @returns {u is number} */ u => typeof u === 'number')
  const usualMs = median(ms)
  const slowMs = quantile(ms, 0.8)
  return {
    n: match.runs.length,
    usualMs,
    slowMs: slowMs === null ? null : Math.max(usualMs ?? 0, slowMs * factor),
    usualUsd: median(usd),
    slowUsd: quantile(usd, 0.8),
    learning: null,
  }
}

/**
 * "Of past runs like this one that were still going at this point, how much
 * longer did they take?" Null figures when fewer than `minSurvivors` were
 * still going; `isPastSlow` once the run has outlasted the slow figure.
 * @param {readonly PastRun[]} runs
 * @param {number} elapsedMs agent time so far
 * @param {{ minSurvivors?: number }} [options]
 * @returns {{ n: number, usualMs: number | null, slowMs: number | null, isPastSlow: boolean }}
 */
export function remainingAfter(runs, elapsedMs, options = {}) {
  const minSurvivors = options.minSurvivors ?? 3
  const all = runs.map(r => r.agentMs)
  const slowAll = quantile(all, 0.8)
  const left = all.filter(ms => ms > elapsedMs).map(ms => ms - elapsedMs)
  const isPastSlow = slowAll !== null && elapsedMs > slowAll
  if (left.length < minSurvivors) return { n: left.length, usualMs: null, slowMs: null, isPastSlow }
  return { n: left.length, usualMs: median(left), slowMs: quantile(left, 0.8), isPastSlow }
}

/**
 * Time left from a share done, assuming the rest goes at the same pace.
 * @param {number} elapsedMs
 * @param {number | null} fraction 0 to 1
 * @returns {number | null}
 */
export function remainingFromProgress(elapsedMs, fraction) {
  if (fraction === null || !(fraction > 0) || fraction >= 1) return null
  return (elapsedMs * (1 - fraction)) / fraction
}

/**
 * Share done by model requests against the usual count, held under 95% so a
 * run past its usual step count never reads as finished.
 * @param {number} stepsDone
 * @param {number | null} usualSteps
 * @returns {number | null}
 */
export function stepFraction(stepsDone, usualSteps) {
  if (!usualSteps || usualSteps <= 0 || stepsDone <= 0) return null
  return Math.min(0.95, stepsDone / usualSteps)
}

/**
 * Share done on the agent's task list, when it wrote one of at least two items.
 * @param {number} done
 * @param {number} total
 * @returns {number | null}
 */
export function taskFraction(done, total) {
  if (total < 2 || done <= 0) return null
  return Math.min(0.95, done / total)
}

/**
 * How much slower the model writes now than usual: usual tokens per second
 * over the recent median, 1 when either is unknown, held to 0.5..3.
 * @param {readonly number[]} recentTps
 * @param {number | null} usualTps
 * @returns {number}
 */
export function speedFactor(recentTps, usualTps) {
  const recent = median(recentTps.filter(t => t > 0))
  if (recent === null || !usualTps || usualTps <= 0) return 1
  return Math.min(3, Math.max(0.5, usualTps / recent))
}

/**
 * The step-time estimate: the survivors' figure, refined by task-list and
 * step progress (weighted 1, 1.5 and 0.5), then the model's share of the time
 * scaled by today's speed.
 * @param {{ elapsedMs: number, survivors: { usualMs: number | null, slowMs: number | null }, taskFraction?: number | null, stepFraction?: number | null, speed?: number, modelShare?: number }} input
 * @returns {{ usualMs: number | null, slowMs: number | null, sources: string[] }}
 */
export function combineRemaining(input) {
  /** @type {Array<[string, number, number]>} */
  const parts = []
  if (input.survivors.usualMs !== null) parts.push(['history', input.survivors.usualMs, 1])
  const fromTasks = remainingFromProgress(input.elapsedMs, input.taskFraction ?? null)
  if (fromTasks !== null) parts.push(['tasks', fromTasks, 1.5])
  const fromSteps = remainingFromProgress(input.elapsedMs, input.stepFraction ?? null)
  if (fromSteps !== null) parts.push(['steps', fromSteps, 0.5])
  if (parts.length === 0) return { usualMs: null, slowMs: null, sources: [] }
  const weight = parts.reduce((s, p) => s + p[2], 0)
  let usual = parts.reduce((s, p) => s + p[1] * p[2], 0) / weight
  const spread =
    input.survivors.usualMs !== null && input.survivors.slowMs !== null && input.survivors.usualMs > 0
      ? input.survivors.slowMs / input.survivors.usualMs
      : 1.5
  const share = Math.min(1, Math.max(0, input.modelShare ?? 0.6))
  const scale = share * (input.speed ?? 1) + (1 - share)
  usual *= scale
  return { usualMs: usual, slowMs: usual * Math.max(1, spread), sources: parts.map(p => p[0]) }
}

/**
 * @typedef {{ target?: number, minN?: number, conformal?: boolean, recent?: number }} CalibrateOptions
 */

/**
 * The self-score for one kind of estimate: how often the actual time came in
 * under the slow figure, and the factor that would have put `target` of them
 * under it (the target-quantile of actual over slow). Under `minN` scored
 * runs the factor stays 1. With `conformal` the factor is split-conformal's
 * finite-sample quantile instead (see factorOf); with `recent` it is fitted on
 * only the latest that many scored runs (in the order given), while `n` and
 * `coverage` still count them all.
 * @param {ReadonlyArray<{ slowMs: number, actualMs: number }>} scored
 * @param {CalibrateOptions} [options]
 * @returns {{ n: number, coverage: number | null, factor: number }}
 */
export function calibrate(scored, options = {}) {
  const ok = scored.filter(s => s.slowMs > 0 && Number.isFinite(s.actualMs))
  if (ok.length === 0) return { n: 0, coverage: null, factor: 1 }
  const coverage = ok.filter(s => s.actualMs <= s.slowMs).length / ok.length
  const fit = options.recent && options.recent > 0 ? ok.slice(-options.recent) : ok
  return { n: ok.length, coverage, factor: factorOf(fit.map(s => s.actualMs / s.slowMs).sort((a, b) => a - b), options) }
}

/**
 * The correction from the ratios of actual over slow, ascending: their
 * target-quantile (interpolated, as quantile()), or with `conformal` the
 * ceil((n + 1) * target)-th smallest, split-conformal's finite-sample quantile,
 * which puts at least `target` of the next exchangeable run under the slow
 * figure. Held to 0.5..4 either way; 1 under `minN` ratios, or when the
 * conformal rank is past the last one (too few to promise the target).
 * @param {readonly number[]} sorted ascending
 * @param {CalibrateOptions} options
 * @returns {number}
 */
function factorOf(sorted, options) {
  const target = options.target ?? 0.8
  const n = sorted.length
  if (n === 0 || n < (options.minN ?? 5)) return 1
  // less a hair, so a product that lands a rounding error above a whole number (100 * 0.55) still rounds to it
  const rank = Math.ceil((n + 1) * target - 1e-9)
  if (options.conformal && rank > n) return 1
  const factor = options.conformal ? sorted[rank - 1] : atSorted(sorted, target)
  return Math.min(4, Math.max(0.5, factor ?? 1))
}

/**
 * The median size of a miss, as |log(actual / usual)|: 0 is exact, 0.69 is
 * off by a factor of two either way.
 * @param {ReadonlyArray<{ usualMs: number, actualMs: number }>} scored
 * @returns {number | null}
 */
export function typicalError(scored) {
  return median(scored.filter(s => s.usualMs > 0 && s.actualMs > 0).map(s => Math.abs(Math.log(s.actualMs / s.usualMs))))
}

/**
 * @typedef {{ taskType: string, actualMs: number, submit?: { usualMs: number, slowMs: number } | null, step?: { usualMs: number, slowMs: number } | null }} ScoredRun
 */

/**
 * Per task type: coverage of the slow figure at submit, the correction to
 * apply to it, and which estimate (at submit or step-based) has missed by less.
 * @param {readonly ScoredRun[]} records
 * @param {{ target?: number, minN?: number }} [options]
 * @returns {Record<string, { n: number, coverage: number | null, factor: number, submitError: number | null, stepError: number | null, best: 'submit' | 'step' }>}
 */
export function scoreByType(records, options = {}) {
  /** @type {Map<string, ScoredRun[]>} */
  const byType = new Map()
  for (const r of records) {
    const list = byType.get(r.taskType)
    if (list) list.push(r)
    else byType.set(r.taskType, [r])
  }
  /** @type {Record<string, { n: number, coverage: number | null, factor: number, submitError: number | null, stepError: number | null, best: 'submit' | 'step' }>} */
  const out = {}
  for (const [type, runs] of byType) {
    const submit = runs.flatMap(r => (r.submit ? [{ ...r.submit, actualMs: r.actualMs }] : []))
    const step = runs.flatMap(r => (r.step ? [{ ...r.step, actualMs: r.actualMs }] : []))
    const cal = calibrate(submit, options)
    const submitError = typicalError(submit)
    const stepError = typicalError(step)
    const best = stepError !== null && (submitError === null || stepError < submitError) ? 'step' : 'submit'
    out[type] = { n: cal.n, coverage: cal.coverage, factor: cal.factor, submitError, stepError, best }
  }
  return out
}

/**
 * The usual and slow agent time of matched runs, as estimateAtSubmit has
 * them (one sort instead of four, for the replay's thousands of calls).
 * @param {readonly PastRun[]} runs
 * @param {number} slowFactor
 * @returns {{ usualMs: number, slowMs: number } | null}
 */
function timesOf(runs, slowFactor) {
  const v = runs.map(r => r.agentMs).filter(Number.isFinite).sort((a, b) => a - b)
  if (v.length === 0) return null
  const at = (/** @type {number} */ q) => {
    const pos = q * (v.length - 1)
    const lo = Math.floor(pos)
    const a = v[lo] ?? 0
    const b = v[Math.ceil(pos)] ?? a
    return a + (b - a) * (pos - lo)
  }
  const usualMs = at(0.5)
  return { usualMs, slowMs: Math.max(usualMs, at(0.8) * slowFactor) }
}

/**
 * The usual and slow cost of matched runs that carry one (the figures
 * estimateAtSubmit shows), null when none do.
 * @param {readonly PastRun[]} runs
 * @returns {{ usualUsd: number, slowUsd: number } | null}
 */
function costsOf(runs) {
  const usd = runs.map(r => r.usd).filter(/** @returns {u is number} */ u => typeof u === 'number' && Number.isFinite(u))
  const usualUsd = median(usd)
  const slowUsd = quantile(usd, 0.8)
  return usualUsd === null || slowUsd === null ? null : { usualUsd, slowUsd }
}

/**
 * @typedef {PastRun & { runId: string, startedAt: number }} ReplayRun
 * @typedef {{ runId: string, taskType: string, queryType: string, startedAt: number, actualMs: number, level: string | null, n: number, submit: { usualMs: number, slowMs: number } | null, cost: { usualUsd: number, slowUsd: number } | null }} Replayed
 * @typedef {'submit' | 'final'} Labels
 */

/**
 * The task type and project an estimate of the run knew. `submit` (the
 * default): the ones known at submit, `submitTaskType` and `submitProject`,
 * which summarizeRuns gives every logged run (what its estimate at submit
 * knew, or for a run that kept none the same rule from its rows). `final`:
 * the run's own, known only once it has done its work, so an estimate made
 * with them is better informed than any live one at submit. A run that
 * carries no submit labels (a test's, a caller's own) is taken as labelled
 * from the start, like a run named by its slash command.
 * @param {PastRun} run
 * @param {Labels} [labels]
 * @returns {{ taskType: string, project: string | null }}
 */
export function labelsOf(run, labels = 'submit') {
  if (labels === 'final') return { taskType: run.taskType, project: run.project ?? null }
  return { taskType: run.submitTaskType ?? run.taskType, project: run.submitProject !== undefined ? run.submitProject : (run.project ?? null) }
}

/**
 * What the estimate at submit would have said for every run, from only the
 * runs that had ENDED before it started: no leakage from the run itself or
 * from anything that finished after. Same matching as live (the same query
 * fields, minimum matches, match limit, fallback levels), and the slow figure
 * uncorrected (`slowFactor` 1) unless asked, so a correction can be fitted to
 * it without feeding on itself. A run with too few matches has `submit: null`.
 * The runs given should all be usable ones (finished, with time on the clock).
 *
 * Runs are bucketed by task type (every level matches on it) and kept in end
 * order, so each run reads a prefix by binary search instead of the whole
 * history. Each run is matched against at most the `window` (REPLAY_WINDOW)
 * runs of its type that ended last before it started, so a replay grows
 * with the history, not with its square: a year of heavy use replays in tens
 * of milliseconds.
 *
 * The query is what the estimate knew when it was made: the task type and
 * project known at submit (labelsOf), with the run's model, effort and prompt
 * size; its shape only shows after the second request, so it is left out.
 * The past runs it matches carry their own final labels, as live's do.
 * `labels: 'final'` queries with the run's own final labels instead, the
 * figure "once the labels are known", which no live estimate at submit has.
 * `queryOf` replaces the query whole. `queryType` is the task type the query
 * had: the self-score keys on it, since live looks its correction up by the
 * task type it knows.
 * @param {readonly ReplayRun[]} runs
 * @param {{ minMatches?: number, limit?: number, slowFactor?: number, levels?: readonly Level[], queryOf?: (run: ReplayRun) => RunQuery, window?: number, labels?: Labels }} [options]
 * @returns {Replayed[]} in start order
 */
export function replay(runs, options = {}) {
  /** @type {Map<string, ReplayRun[]>} */
  const byType = new Map()
  for (const r of runs) {
    const list = byType.get(r.taskType)
    if (list) list.push(r)
    else byType.set(r.taskType, [r])
  }
  for (const list of byType.values()) list.sort((a, b) => a.endedAt - b.endedAt)
  /** @type {Replayed[]} */
  const out = []
  for (const run of [...runs].sort((a, b) => a.startedAt - b.startedAt)) {
    const query = options.queryOf ? options.queryOf(run) : { ...run, ...labelsOf(run, options.labels), shape: undefined }
    const list = byType.get(query.taskType) ?? []
    // The runs that ended at or before this one started.
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((list[mid]?.endedAt ?? Infinity) <= run.startedAt) lo = mid + 1
      else hi = mid
    }
    const from = Math.max(0, lo - (options.window ?? REPLAY_WINDOW))
    const match = matchRuns(list.slice(from, lo), query, { minMatches: options.minMatches, limit: options.limit, levels: options.levels, sortedAsc: true })
    const submit = match.learning ? null : timesOf(match.runs, options.slowFactor ?? 1)
    const cost = match.learning ? null : costsOf(match.runs)
    out.push({ runId: run.runId, taskType: run.taskType, queryType: query.taskType, startedAt: run.startedAt, actualMs: run.agentMs, level: match.level, n: match.runs.length, submit, cost })
  }
  return out
}

/**
 * @typedef {{ runId: string, taskType: string, startedAt: number, actualMs: number, level: string | null, n: number, step: { usualMs: number, slowMs: number } | null }} ReplayedAt
 */

/**
 * What the history part of the step estimate would have said for each run
 * that was still going after its first `k` model requests, from only the runs
 * that had ended before it started. `stateOf` gives, for a run, the agent
 * time gone by then and the query as it was known then (task type from the
 * skills loaded so far, the project from the folders touched so far, the
 * shape once known); null when the run had fewer requests. Like the live
 * estimate, the matches still going at that point give the time left
 * (remainingAfter), falling back to the whole-run figure while that is still
 * ahead. Task-list progress and writing speed are not replayed (the rows do
 * not hold the task list, and speed is a live reading), so this scores what
 * the matching adds, not the whole estimate.
 * @param {readonly ReplayRun[]} runs
 * @param {{ stateOf: (run: ReplayRun) => { elapsedMs: number, query: RunQuery } | null, minMatches?: number, limit?: number, levels?: readonly Level[] }} options
 * @returns {ReplayedAt[]} in start order
 */
export function replayAtStep(runs, options) {
  const byEnd = [...runs].sort((a, b) => a.endedAt - b.endedAt)
  /** @type {ReplayedAt[]} */
  const out = []
  for (const run of [...runs].sort((a, b) => a.startedAt - b.startedAt)) {
    const state = options.stateOf(run)
    if (!state || !(state.elapsedMs < run.agentMs)) continue
    let lo = 0
    let hi = byEnd.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((byEnd[mid]?.endedAt ?? Infinity) <= run.startedAt) lo = mid + 1
      else hi = mid
    }
    const match = matchRuns(byEnd.slice(0, lo), state.query, { minMatches: options.minMatches, limit: options.limit, levels: options.levels, sortedAsc: true })
    /** @type {ReplayedAt} */
    const row = { runId: run.runId, taskType: run.taskType, startedAt: run.startedAt, actualMs: run.agentMs, level: match.level, n: match.runs.length, step: null }
    out.push(row)
    if (match.learning) continue
    const ms = match.runs.map(r => r.agentMs)
    const survivors = remainingAfter(match.runs, state.elapsedMs)
    let left = survivors.usualMs
    let leftSlow = survivors.slowMs
    const usual = median(ms)
    const slow = quantile(ms, 0.8)
    if (left === null && usual !== null && slow !== null && usual > state.elapsedMs) {
      left = usual - state.elapsedMs
      leftSlow = Math.max(left, slow - state.elapsedMs)
    }
    if (left !== null && leftSlow !== null) row.step = { usualMs: state.elapsedMs + left, slowMs: state.elapsedMs + leftSlow }
  }
  return out
}

/** The newest past agents of a type the subagent-aware estimate reads, and the fewest it needs. */
export const AGENT_LIMIT = 100
export const AGENT_MIN = 5
/** The newest tails (the main loop's time after its last subagent) it reads, and the fewest it needs. */
export const TAIL_LIMIT = 50
export const TAIL_MIN = 5

/**
 * @typedef {{ type: string, ranMs: number }} GoingAgent
 */

/**
 * The count of an ascending list's values at or under x.
 * @param {readonly number[]} v ascending
 * @param {number} x
 */
function countAtMost(v, x) {
  let lo = 0
  let hi = v.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((v[mid] ?? Infinity) <= x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * The q-quantile of the slowest of parallel times plus a tail, all taken as
 * independent: the least x where the mean over tails t of the product over
 * agents of P(time left <= x - t) reaches q. That x is always one agent's
 * time plus one tail, so the search runs over those sums.
 * @param {ReadonlyArray<readonly number[]>} lefts each agent's possible times left, ascending
 * @param {readonly number[]} tails
 * @param {number} q
 * @returns {number}
 */
function maxPlusQuantile(lefts, tails, q) {
  const reach = (/** @type {number} */ x) => {
    let sum = 0
    for (const t of tails) {
      let p = 1
      for (const v of lefts) {
        p *= countAtMost(v, x - t) / v.length
        if (p === 0) break
      }
      sum += p
    }
    return sum / tails.length
  }
  const sums = [...new Set(lefts.flatMap(v => tails.flatMap(t => v.map(x => x + t))))].sort((a, b) => a - b)
  let lo = 0
  let hi = sums.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (reach(sums[mid] ?? Infinity) >= q - 1e-12) hi = mid
    else lo = mid + 1
  }
  return sums[lo] ?? 0
}

/**
 * The time left while subagents are going: until the last of them returns,
 * then the main loop's own tail. Each going agent's time left comes from the
 * past agents of its type that ran longer than it has so far (each less what
 * it has run); parallel agents finish with the slowest, so they combine as
 * the max, not the sum; the tails are past runs' main-loop time after their
 * last subagent returned. The figures are the median and 80th percentile of
 * that whole, the agents and the tail taken as independent. Null when none
 * is going, when a going agent's type has fewer than `minAgents` past agents
 * or fewer than `minSurvivors` that ran longer, or with fewer than `minTails`
 * tails: the history-only figure stands then.
 *
 * Scored by scripts/label-eval.mjs, not used live. On the run clock, which
 * counts background subagents' work, the history-only step figure already
 * holds near 80% on runs that hand work to agents, and this one runs long;
 * it also moves the read and shell figures off target, so it fails the bar
 * set before the test.
 * @param {readonly GoingAgent[]} going
 * @param {ReadonlyMap<string, readonly number[]>} durations past agents' times by type
 * @param {readonly number[]} tails
 * @param {{ minAgents?: number, minSurvivors?: number, minTails?: number }} [options]
 * @returns {{ usualMs: number, slowMs: number } | null}
 */
export function remainingWithAgents(going, durations, tails, options = {}) {
  const minAgents = options.minAgents ?? AGENT_MIN
  const minSurvivors = options.minSurvivors ?? 3
  const minTails = options.minTails ?? TAIL_MIN
  const tailsOk = tails.filter(t => Number.isFinite(t) && t >= 0)
  if (going.length === 0 || tailsOk.length < minTails) return null
  /** @type {number[][]} */
  const lefts = []
  for (const a of going) {
    const past = (durations.get(a.type) ?? []).filter(Number.isFinite)
    if (past.length < minAgents) return null
    const left = past.filter(ms => ms > a.ranMs).map(ms => ms - a.ranMs).sort((x, y) => x - y)
    if (left.length < minSurvivors) return null
    lefts.push(left)
  }
  return { usualMs: maxPlusQuantile(lefts, tailsOk, 0.5), slowMs: maxPlusQuantile(lefts, tailsOk, 0.8) }
}

/**
 * @typedef {{ type: string, startedAt: number, endedAt: number }} RunAgentSpan
 * @typedef {ReplayRun & { agents?: readonly RunAgentSpan[], mainLastAt?: number }} AgentReplayRun
 * @typedef {{ runId: string, startedAt: number, actualMs: number, going: number, agents: { usualMs: number, slowMs: number } | null }} ReplayedAgents
 */

/**
 * The main loop's own time after the run's last subagent returned: its last
 * activity less that return, never below 0 (an agent that came back after the
 * main loop's last turn left no tail). Null for a run with no subagents.
 * @param {AgentReplayRun} run
 * @returns {number | null}
 */
export function agentTail(run) {
  const agents = run.agents ?? []
  if (agents.length === 0) return null
  const lastBack = Math.max(...agents.map(a => a.endedAt))
  return Math.max(0, (run.mainLastAt ?? run.endedAt) - lastBack)
}

/**
 * What the subagent-aware estimate (remainingWithAgents) would have said for
 * each run still going at its state, from only the runs that had ENDED before
 * it started: their agents' times by type (the newest AGENT_LIMIT of each)
 * and their tails (the newest TAIL_LIMIT). `stateOf` gives the agent time gone
 * and the clock moment `at` of the state; the run's own agents that had
 * started by then and not yet returned are the ones going. `going` counts
 * them; `agents` is null where none is going or their history is too thin,
 * and the history-only step figure (replayAtStep) stands. Same runs as
 * replayAtStep given the same states: those with a state short of their time.
 * @param {readonly AgentReplayRun[]} runs
 * @param {{ stateOf: (run: AgentReplayRun) => { elapsedMs: number, at: number } | null }} options
 * @returns {ReplayedAgents[]} in start order
 */
export function replayAgentsAtStep(runs, options) {
  const byEnd = [...runs].sort((a, b) => a.endedAt - b.endedAt)
  /** @type {Map<string, number[]>} oldest first */
  const durations = new Map()
  /** @type {number[]} oldest first */
  const tails = []
  /** @type {ReplayedAgents[]} */
  const out = []
  let next = 0
  for (const run of [...runs].sort((a, b) => a.startedAt - b.startedAt)) {
    // fold in every run that ended before this one started, and nothing else
    for (; next < byEnd.length && (byEnd[next]?.endedAt ?? Infinity) <= run.startedAt; next++) {
      const done = /** @type {AgentReplayRun} */ (byEnd[next])
      for (const a of done.agents ?? []) {
        const list = durations.get(a.type) ?? []
        list.push(Math.max(0, a.endedAt - a.startedAt))
        durations.set(a.type, list)
      }
      const tail = agentTail(done)
      if (tail !== null) tails.push(tail)
    }
    const state = options.stateOf(run)
    if (!state || !(state.elapsedMs < run.agentMs)) continue
    const going = (run.agents ?? []).filter(a => a.startedAt <= state.at && a.endedAt > state.at).map(a => ({ type: a.type, ranMs: state.at - a.startedAt }))
    const newest = new Map([...new Set(going.map(a => a.type))].map(type => [type, (durations.get(type) ?? []).slice(-AGENT_LIMIT)]))
    const left = remainingWithAgents(going, newest, tails.slice(-TAIL_LIMIT))
    out.push({
      runId: run.runId,
      startedAt: run.startedAt,
      actualMs: run.agentMs,
      going: going.length,
      agents: left === null ? null : { usualMs: state.elapsedMs + left.usualMs, slowMs: state.elapsedMs + Math.max(left.usualMs, left.slowMs) },
    })
  }
  return out
}

/**
 * The step rows (replayAtStep's) with the subagent-aware figure
 * (replayAgentsAtStep's) in place of the history-only one wherever agents
 * were going and it had the history to say, so the two score on the same
 * rows: a row with no history-only figure keeps none. `going` marks the rows
 * it changed.
 * @param {readonly ReplayedAt[]} stepRows
 * @param {readonly ReplayedAgents[]} agentRows
 * @returns {Array<ReplayedAt & { going: boolean }>}
 */
export function withAgents(stepRows, agentRows) {
  const byId = new Map(agentRows.map(r => [r.runId, r]))
  return stepRows.map(r => {
    const figure = byId.get(r.runId)?.agents
    return r.step && figure ? { ...r, step: figure, going: true } : { ...r, going: false }
  })
}

/**
 * @typedef {{ n: number, coverage: number | null, factor: number, submitError: number | null, stepError: number | null, best: 'submit' | 'step', shown: { n: number, coverage: number | null } }} TypeScore
 */

/**
 * The self-score per task type. The correction (`factor`), coverage and
 * submit error come from the replay (uncorrected estimates over every run,
 * live ones included), so the correction never feeds on its own output. What
 * a live run actually showed (`eta`, already corrected) is scored apart as
 * `shown`. The step-versus-submit choice compares the two on the same runs
 * where both exist, using the logged `etaMid` for the step figure.
 *
 * The key is the task type the estimate knew (the replay's `queryType`: at
 * submit by default), since live looks the correction up by the task type it
 * knows: a run named by a skill it loads later is scored, and corrects, under
 * the type it was estimated as (often freeform). With `labels: 'final'` the
 * key is the run's own task type, the score once the labels are known.
 * @param {ReadonlyArray<ReplayRun & { eta?: { usualMs: number | null, slowMs: number | null } | null, etaMid?: { usualMs: number, slowMs: number } | null }>} runs usable runs
 * @param {{ target?: number, minN?: number, minMatches?: number, limit?: number, levels?: readonly Level[], queryOf?: (run: ReplayRun) => RunQuery, window?: number, labels?: Labels }} [options]
 * @returns {Record<string, TypeScore>}
 */
export function scoreRuns(runs, options = {}) {
  const mids = new Map(runs.flatMap(r => (r.etaMid ? [[r.runId, { usualMs: r.etaMid.usualMs, slowMs: r.etaMid.slowMs }]] : [])))
  const replayed = replay(runs, options)
  const base = scoreByType(replayed.map(r => ({ taskType: r.queryType, actualMs: r.actualMs, submit: r.submit, step: mids.get(r.runId) ?? null })), options)
  /** @type {Map<string, Array<{ slowMs: number, actualMs: number }>>} */
  const shown = new Map()
  for (const r of runs) {
    if (!r.eta || r.eta.usualMs === null || r.eta.slowMs === null) continue
    const type = labelsOf(r, options.labels).taskType
    const list = shown.get(type)
    const entry = { slowMs: r.eta.slowMs, actualMs: r.agentMs }
    if (list) list.push(entry)
    else shown.set(type, [entry])
  }
  /** @type {Map<string, { submit: Array<{ usualMs: number, actualMs: number }>, step: Array<{ usualMs: number, actualMs: number }> }>} */
  const paired = new Map()
  for (const r of replayed) {
    const step = mids.get(r.runId)
    if (!r.submit || !step) continue
    const p = paired.get(r.queryType) ?? { submit: [], step: [] }
    p.submit.push({ usualMs: r.submit.usualMs, actualMs: r.actualMs })
    p.step.push({ usualMs: step.usualMs, actualMs: r.actualMs })
    paired.set(r.queryType, p)
  }
  /** @type {Record<string, TypeScore>} */
  const out = {}
  for (const [type, s] of Object.entries(base)) {
    const p = paired.get(type)
    const pairedSubmit = p ? typicalError(p.submit) : null
    const pairedStep = p ? typicalError(p.step) : null
    const best = pairedStep !== null && (pairedSubmit === null || pairedStep < pairedSubmit) ? 'step' : 'submit'
    const cal = calibrate(shown.get(type) ?? [], options)
    out[type] = { ...s, best, shown: { n: cal.n, coverage: cal.coverage } }
  }
  return out
}

/**
 * @typedef {{ n: number, coverage: number | null, error: number | null }} GroupScore
 */

/**
 * The replay's self-score (coverage of the slow figure, typical miss) for
 * any grouping of the runs, such as the shape of a freeform run. The replay
 * runs over every run given, so a group is scored as the live estimate would
 * have been; `keyOf` returns null to leave a run out.
 * @param {ReadonlyArray<ReplayRun>} runs usable runs
 * @param {(run: ReplayRun) => string | null} keyOf
 * @param {Parameters<typeof replay>[1] & { target?: number, minN?: number }} [options]
 * @returns {Record<string, GroupScore>}
 */
export function scoreGroups(runs, keyOf, options = {}) {
  const keys = new Map(runs.map(r => [r.runId, keyOf(r)]))
  /** @type {Map<string, Array<{ usualMs: number, slowMs: number, actualMs: number }>>} */
  const groups = new Map()
  for (const r of replay(runs, options)) {
    const key = keys.get(r.runId)
    if (key === null || key === undefined || !r.submit) continue
    const list = groups.get(key)
    const entry = { ...r.submit, actualMs: r.actualMs }
    if (list) list.push(entry)
    else groups.set(key, [entry])
  }
  /** @type {Record<string, GroupScore>} */
  const out = {}
  for (const [key, list] of groups) {
    const cal = calibrate(list, options)
    out[key] = { n: cal.n, coverage: cal.coverage, error: typicalError(list) }
  }
  return out
}

/**
 * The same score for cost: how often the cost came in under the slow figure
 * (the 80th percentile of the matched runs' cost), and the typical miss of the
 * usual one. Only runs whose cost is known whole count, as actuals and as
 * history; the key is the task type the estimate knew (as scoreRuns has it),
 * plus `all`.
 * @param {ReadonlyArray<ReplayRun & { unpricedTurns?: number }>} runs usable runs
 * @param {Parameters<typeof replay>[1] & { target?: number, minN?: number }} [options]
 * @returns {Record<string, GroupScore>}
 */
export function scoreCost(runs, options = {}) {
  const priced = runs.filter(isWholeCost)
  const actual = new Map(priced.map(r => [r.runId, /** @type {number} */ (r.usd)]))
  /** @type {Map<string, Array<{ usualMs: number, slowMs: number, actualMs: number }>>} */
  const groups = new Map()
  for (const r of replay(priced, options)) {
    const usd = actual.get(r.runId)
    if (!r.cost || usd === undefined) continue
    // the helpers score "ms"; here the same fields hold dollars
    const entry = { usualMs: r.cost.usualUsd, slowMs: r.cost.slowUsd, actualMs: usd }
    for (const key of [r.queryType, 'all']) {
      const list = groups.get(key)
      if (list) list.push(entry)
      else groups.set(key, [entry])
    }
  }
  /** @type {Record<string, GroupScore>} */
  const out = {}
  for (const [key, list] of groups) {
    const cal = calibrate(list, options)
    out[key] = { n: cal.n, coverage: cal.coverage, error: typicalError(list) }
  }
  return out
}

/**
 * The quantile of an ascending list, by the same interpolation as quantile().
 * @param {readonly number[]} v
 * @param {number} q
 * @returns {number | null}
 */
function atSorted(v, q) {
  if (v.length === 0) return null
  const pos = q * (v.length - 1)
  const lo = Math.floor(pos)
  const a = v[lo] ?? 0
  const b = v[Math.ceil(pos)] ?? a
  return a + (b - a) * (pos - lo)
}

/**
 * @param {number[]} v ascending, changed in place
 * @param {number} x
 */
function insertSorted(v, x) {
  let lo = 0
  let hi = v.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((v[mid] ?? Infinity) <= x) lo = mid + 1
    else hi = mid
  }
  v.splice(lo, 0, x)
}

/**
 * @typedef {{ coverage: number, spread: number | null, slowMs: number | null, error: number | null, scale: number, equal: { spread: number | null, slowMs: number | null } }} PredictorScore
 * @typedef {{ coverage: number, hits: number, spread: number | null, slowMs: number | null, scale: number, raw: { coverage: number, hits: number, slowMs: number | null }, score: number | null, scores: number[] }} HoldoutPredictor
 * @typedef {{ n: number, trainN: number, predictors: Record<'matcher' | 'matcherCorrected' | 'type' | 'global', HoldoutPredictor> }} HoldoutScore
 * @typedef {{ n: number, predictors: Record<'matcher' | 'matcherCorrected' | 'type' | 'global', PredictorScore>, holdout: HoldoutScore | null }} BaselineScore
 * @typedef {{ usualMs: number, slowMs: number }} Figure
 * @typedef {{ runId: string, taskType: string, startedAt: number, actualMs: number, preds: Record<string, Figure> }} PredictedRow
 */

/** The share of scored runs, earliest first, that the baselines' coverage scale is fitted on. */
export const HOLDOUT_TRAIN = 0.7

/** The predictors compared, and what each is. */
export const BASELINES = /** @type {const} */ (['matcher', 'matcherCorrected', 'type', 'global'])

/** The latest scored runs of a task type the conformal correction is fitted on. */
export const CONFORMAL_WINDOW = 100

/**
 * The interval score of an upper bound held `target` of the time: the slow
 * figure plus 1 / (1 - target) times any overrun past it (5x at 80%). This is
 * Gneiting and Raftery's interval score (2007) with the lower end at 0, the
 * Winkler score of a one-sided band, and the pinball loss at `target` scaled
 * by 1 / (1 - target) plus the actual, which every predictor shares on a run.
 * It is proper: its expected value is lowest at the true 80th percentile, so a
 * figure set too low pays for each overrun and one set too high pays for its
 * width, and predictors compare on the same runs with no coverage matching.
 * Lower is better, in the figure's own unit (ms or dollars).
 * @param {number} slow
 * @param {number} actual
 * @param {number} [target]
 * @returns {number}
 */
export function intervalScore(slow, actual, target = 0.8) {
  return slow + Math.max(0, actual - slow) / (1 - target)
}

/**
 * How often `a` has the lower mean than `b` over paired bootstrap resamples:
 * `rounds` (500) draws, with replacement, of as many runs as there are, the
 * same runs for both. The draws come from a seeded generator (mulberry32), so
 * the same scores always give the same rate. A tied resample is no win.
 * @param {readonly number[]} a per-run scores
 * @param {readonly number[]} b the same runs' scores, in the same order
 * @param {{ rounds?: number, seed?: number }} [options]
 * @returns {number | null} null for no pairs
 */
export function bootstrapWins(a, b, options = {}) {
  const n = Math.min(a.length, b.length)
  if (n === 0) return null
  const rounds = options.rounds ?? 500
  let state = (options.seed ?? 0x5eed) >>> 0
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const diff = Array.from({ length: n }, (_, i) => (a[i] ?? 0) - (b[i] ?? 0))
  let wins = 0
  for (let k = 0; k < rounds; k++) {
    let sum = 0
    for (let i = 0; i < n; i++) sum += diff[Math.floor(random() * n)] ?? 0
    if (sum < 0) wins++
  }
  return wins / rounds
}

/**
 * Does the run carry a cost known whole (every turn priced)? Only those count
 * as history or as actuals when cost is scored.
 * @param {ReplayRun & { unpricedTurns?: number }} r
 */
const isWholeCost = r => typeof r.usd === 'number' && r.usd > 0 && !((r.unpricedTurns ?? 0) > 0)

/**
 * Every run predicted from only the runs that had ENDED before it started, by
 * every predictor scoreBaselines and scoreConformal compare, in start order.
 * Only runs all of them can predict are kept, so they face the same runs (a
 * type or the global pool needs `minMatches` earlier runs). The four
 * baselines (see scoreBaselines), plus two corrections of the matcher's slow
 * figure: `fitted`, the one the live estimate uses (calibrate over every
 * earlier scored run of the type), and `conformal`, calibrate's conformal
 * quantile over the latest `recent` (CONFORMAL_WINDOW) of them. With
 * `measure: 'cost'` the figures and actuals are dollars, held in the ms fields
 * as scoreCost does, over the runs whose cost is known whole.
 *
 * Every predictor knows what the matcher's query knew: the per-type figure
 * takes the earlier runs of the task type known at submit (the replay's
 * `queryType`; the earlier runs go by their own final labels, as live's
 * history does), and the corrections are fitted per that type, as live looks
 * them up. A row's `taskType` is that type too.
 * @param {ReadonlyArray<ReplayRun & { unpricedTurns?: number }>} runs usable runs
 * @param {Parameters<typeof replay>[1] & { target?: number, minN?: number, measure?: 'time' | 'cost', recent?: number }} options
 * @returns {PredictedRow[]}
 */
function predictedRows(runs, options) {
  const need = options.minMatches ?? 5
  const isCost = options.measure === 'cost'
  const pool = isCost ? runs.filter(isWholeCost) : runs
  const valueOf = (/** @type {ReplayRun} */ r) => (isCost ? /** @type {number} */ (r.usd) : r.agentMs)
  /** @type {Map<string, Figure>} the matcher's uncorrected figure, per run */
  const matched = new Map()
  /** @type {Map<string, string>} the task type each run's estimate knew */
  const known = new Map()
  for (const r of replay(pool, options)) {
    known.set(r.runId, r.queryType)
    const fig = isCost ? (r.cost ? { usualMs: r.cost.usualUsd, slowMs: r.cost.slowUsd } : null) : r.submit
    if (fig) matched.set(r.runId, fig)
  }
  const knownType = (/** @type {ReplayRun} */ r) => known.get(r.runId) ?? r.taskType
  const ended = [...pool].sort((a, b) => a.endedAt - b.endedAt)
  /** @type {Map<string, number[]>} */
  const typeValues = new Map()
  /** @type {number[]} */
  const allValues = []
  /** @type {Map<string, Array<{ slowMs: number, actualMs: number }>>} the type's scored runs, in end order */
  const typeScored = new Map()
  /** @type {Map<string, number[]>} the same runs' actual over slow, ascending */
  const typeRatios = new Map()
  const fit = { target: options.target, minN: options.minN }
  /** @type {PredictedRow[]} */
  const rows = []
  let next = 0
  for (const run of [...pool].sort((a, b) => a.startedAt - b.startedAt)) {
    // fold in every run that ended before this one started, and nothing else
    for (; next < ended.length && (ended[next]?.endedAt ?? Infinity) <= run.startedAt; next++) {
      const done = /** @type {ReplayRun} */ (ended[next])
      const value = valueOf(done)
      const values = typeValues.get(done.taskType) ?? []
      insertSorted(values, value)
      typeValues.set(done.taskType, values)
      insertSorted(allValues, value)
      const fig = matched.get(done.runId)
      if (fig) {
        const doneType = knownType(done)
        const scored = typeScored.get(doneType) ?? []
        scored.push({ slowMs: fig.slowMs, actualMs: value })
        typeScored.set(doneType, scored)
        if (fig.slowMs > 0) {
          const ratios = typeRatios.get(doneType) ?? []
          insertSorted(ratios, value / fig.slowMs)
          typeRatios.set(doneType, ratios)
        }
      }
    }
    const fig = matched.get(run.runId)
    const type = knownType(run)
    const own = typeValues.get(type) ?? []
    if (!fig || own.length < need || allValues.length < need) continue
    const scored = typeScored.get(type) ?? []
    const corrected = (/** @type {number} */ factor) => ({ usualMs: fig.usualMs, slowMs: Math.max(fig.usualMs, fig.slowMs * factor) })
    rows.push({
      runId: run.runId,
      taskType: type,
      startedAt: run.startedAt,
      actualMs: valueOf(run),
      preds: {
        matcher: fig,
        matcherCorrected: corrected(calibrate(scored.slice(-50), fit).factor),
        type: { usualMs: atSorted(own, 0.5) ?? 0, slowMs: atSorted(own, 0.8) ?? 0 },
        global: { usualMs: atSorted(allValues, 0.5) ?? 0, slowMs: atSorted(allValues, 0.8) ?? 0 },
        // calibrate(scored, fit).factor, read off the sorted ratios instead of sorting them again for every run
        fitted: corrected(factorOf(typeRatios.get(type) ?? [], fit)),
        conformal: corrected(calibrate(scored.slice(-(options.recent ?? CONFORMAL_WINDOW)), { ...fit, conformal: true }).factor),
      },
    })
  }
  return rows
}

/**
 * The split moment of a holdout: the start of the first held-out row, the one
 * HOLDOUT_TRAIN (70%) of the way through rows in start order. Infinity (none
 * held out) under two rows.
 * @param {readonly PredictedRow[]} rows
 * @returns {number}
 */
function cutOf(rows) {
  return rows.length > 1 ? (rows[Math.floor(rows.length * HOLDOUT_TRAIN)]?.startedAt ?? Infinity) : Infinity
}

/**
 * Does the matcher beat naive predictors? Every run is predicted four ways
 * from only the runs that had ENDED before it started (as replay does):
 * `matcher` (the replay's uncorrected slow figure), `matcherCorrected` (its
 * slow figure times the type's correction, fitted on the type's latest 50
 * earlier scored runs), `type` (the median and 80th percentile of every
 * earlier run of its type) and `global` (the median and 80th percentile of
 * every earlier run of any type). Every one knows only the labels the
 * matcher's query knew, at submit by default (`labels: 'final'` gives them
 * all the run's own): "its type" is the task type known then. Only runs all
 * four can predict are scored, so they face the same runs (a type or the
 * global pool needs `minMatches` earlier runs). `measure: 'cost'` scores
 * dollars the same way.
 *
 * Per predictor: `coverage` (finished under its slow figure), `spread` (the
 * median slow over usual) and `slowMs` (the median slow figure), the sharpness;
 * and `error` (the typical miss of the usual figure). `equal` repeats the
 * sharpness after scaling the slow figure by `scale`, the factor that gives
 * it the uncorrected matcher's coverage on these same runs. That fit is in
 * sample, which favours the baselines, so `holdout` repeats it on the last
 * 30% of the scored runs by start time, with the scale fitted on the first
 * HOLDOUT_TRAIN (70%). The holdout also scores each figure as it stands
 * (`raw`, no scale) by its interval score (intervalScore), per run (`scores`)
 * and on average (`score`): that needs no coverage matching, and is what
 * baselineVerdict reads. The key is that task type, plus `all`; a type's
 * split is at the same moment in time as the split of all runs.
 * @param {ReadonlyArray<ReplayRun>} runs usable runs
 * @param {Parameters<typeof replay>[1] & { target?: number, minN?: number, measure?: 'time' | 'cost' }} [options]
 * @returns {Record<string, BaselineScore>}
 */
export function scoreBaselines(runs, options = {}) {
  const rows = predictedRows(runs, options)
  /** @type {Map<string, PredictedRow[]>} */
  const groups = new Map([['all', rows]])
  for (const r of rows) {
    const list = groups.get(r.taskType) ?? []
    list.push(r)
    groups.set(r.taskType, list)
  }
  const cut = cutOf(rows)
  /** @type {Record<string, BaselineScore>} */
  const out = {}
  for (const [key, list] of groups) {
    const matcherCoverage = list.filter(r => r.actualMs <= (r.preds.matcher?.slowMs ?? 0)).length / list.length
    const predictors = /** @type {Record<string, PredictorScore>} */ ({})
    for (const name of BASELINES) {
      const pairs = list.map(r => ({ ...(/** @type {Figure} */ (r.preds[name])), actualMs: r.actualMs }))
      const ok = pairs.filter(p => p.usualMs > 0 && p.slowMs > 0)
      const scale = name === 'matcher' ? 1 : (quantile(ok.map(p => p.actualMs / p.slowMs), matcherCoverage) ?? 1)
      predictors[name] = {
        coverage: pairs.filter(p => p.actualMs <= p.slowMs).length / pairs.length,
        spread: median(ok.map(p => p.slowMs / p.usualMs)),
        slowMs: median(pairs.map(p => p.slowMs)),
        error: typicalError(pairs),
        scale,
        equal: { spread: median(ok.map(p => (p.slowMs * scale) / p.usualMs)), slowMs: median(pairs.map(p => p.slowMs * scale)) },
      }
    }
    out[key] = { n: list.length, predictors: /** @type {BaselineScore['predictors']} */ (predictors), holdout: holdoutOf(list, cut, options.target) }
  }
  return out
}

/**
 * The baselines scored out of sample: each predictor's coverage scale is
 * fitted on the rows that started before `cut` and read on the rest, and each
 * figure as it stands is scored there by its interval score.
 * @param {readonly PredictedRow[]} list in start order
 * @param {number} cut
 * @param {number} [target]
 * @returns {HoldoutScore | null} null when either side is empty
 */
function holdoutOf(list, cut, target) {
  const train = list.filter(r => r.startedAt < cut)
  const test = list.filter(r => r.startedAt >= cut)
  if (train.length === 0 || test.length === 0) return null
  const trainCoverage = train.filter(r => r.actualMs <= (r.preds.matcher?.slowMs ?? 0)).length / train.length
  const predictors = /** @type {Record<string, HoldoutPredictor>} */ ({})
  for (const name of BASELINES) {
    const at = (/** @type {typeof train} */ rows) => rows.map(r => ({ ...(/** @type {Figure} */ (r.preds[name])), actualMs: r.actualMs }))
    const scale = name === 'matcher' ? 1 : (quantile(at(train).filter(p => p.slowMs > 0).map(p => p.actualMs / p.slowMs), trainCoverage) ?? 1)
    const pairs = at(test)
    const ok = pairs.filter(p => p.usualMs > 0 && p.slowMs > 0)
    const hits = pairs.filter(p => p.actualMs <= p.slowMs * scale).length
    const rawHits = pairs.filter(p => p.actualMs <= p.slowMs).length
    const scores = pairs.map(p => intervalScore(p.slowMs, p.actualMs, target))
    predictors[name] = {
      coverage: hits / pairs.length,
      hits,
      spread: median(ok.map(p => (p.slowMs * scale) / p.usualMs)),
      slowMs: median(pairs.map(p => p.slowMs * scale)),
      scale,
      raw: { coverage: rawHits / pairs.length, hits: rawHits, slowMs: median(pairs.map(p => p.slowMs)) },
      score: scores.reduce((s, x) => s + x, 0) / scores.length,
      scores,
    }
  }
  return { n: test.length, trainN: train.length, predictors: /** @type {HoldoutScore['predictors']} */ (predictors) }
}

/** A verdict needs a gap of at least this much, relative, in the mean interval score. */
export const VERDICT_BAND = 0.05
/** A verdict is unclear below this many held-out runs. */
export const VERDICT_MIN_N = 100
/** The bootstrap resamples of the held-out runs behind a verdict. */
export const VERDICT_ROUNDS = 500
/** The share of those resamples the winner must win. */
export const VERDICT_WINS = 0.9

/**
 * Does the matcher beat the per-type median out of sample? Both slow figures,
 * as they stand, are scored on the same held-out runs by their mean interval
 * score (intervalScore), so neither is scaled to the other's coverage. `yes`
 * when the matcher's mean is at least 5% lower and it is lower in at least 90%
 * of 500 paired bootstrap resamples of those runs; `no` when the per-type
 * median wins by the same rule; `unclear` otherwise, under 100 held-out runs,
 * or with none scored. The coverages are how often each figure held there.
 * @param {BaselineScore | undefined} score a row of scoreBaselines (time or cost), usually `all`
 * @returns {{ verdict: 'yes' | 'no' | 'unclear', n: number, matcherScore: number | null, typeScore: number | null, ratio: number | null, winRate: number | null, matcherCoverage: number | null, typeCoverage: number | null }}
 */
export function baselineVerdict(score) {
  const h = score?.holdout
  const m = h?.predictors.matcher
  const t = h?.predictors.type
  const n = h?.n ?? 0
  const matcherScore = m?.score ?? null
  const typeScore = t?.score ?? null
  const shown = { n, matcherScore, typeScore, matcherCoverage: m?.raw.coverage ?? null, typeCoverage: t?.raw.coverage ?? null }
  if (!m || !t || matcherScore === null || typeScore === null || !(matcherScore > 0) || !(typeScore > 0)) return { verdict: 'unclear', ...shown, ratio: null, winRate: null }
  const ratio = matcherScore / typeScore
  // the same seed draws the same resamples both ways, so a loss is the mirror of a win
  const winRate = bootstrapWins(m.scores, t.scores, { rounds: VERDICT_ROUNDS })
  const lossRate = bootstrapWins(t.scores, m.scores, { rounds: VERDICT_ROUNDS })
  /** @type {'yes' | 'no' | 'unclear'} */
  let verdict = 'unclear'
  if (n >= VERDICT_MIN_N && winRate !== null && lossRate !== null) {
    if (ratio <= 1 - VERDICT_BAND && winRate >= VERDICT_WINS) verdict = 'yes'
    else if (1 / ratio <= 1 - VERDICT_BAND && lossRate >= VERDICT_WINS) verdict = 'no'
  }
  return { verdict, ...shown, ratio, winRate }
}

/**
 * The bar a new correction of the slow figure must clear on held-out runs to
 * replace the one in use: coverage closer to the target, and a median slow
 * figure no wider.
 * @param {{ coverage: number, slowMs: number | null }} current
 * @param {{ coverage: number, slowMs: number | null }} candidate
 * @param {number} [target]
 * @returns {boolean}
 */
export function passesBar(current, candidate, target = 0.8) {
  if (candidate.slowMs === null || current.slowMs === null) return false
  return Math.abs(candidate.coverage - target) < Math.abs(current.coverage - target) && candidate.slowMs <= current.slowMs
}

/**
 * @typedef {{ coverage: number, hits: number, slowMs: number | null, score: number }} CorrectionScore
 * @typedef {{ n: number, trainN: number, recent: number, fitted: CorrectionScore, conformal: CorrectionScore, better: boolean, rows: Array<{ runId: string, actualMs: number, fittedMs: number, conformalMs: number }> }} ConformalScore
 */

/**
 * Two corrections of the matcher's slow figure at submit, scored on the same
 * held-out runs as scoreBaselines (the last 30% of the runs it compares, by
 * start time). `fitted` is the correction the live estimate uses: the 80th
 * percentile, interpolated, of actual over slow across every earlier scored
 * run of the task type. `conformal` is split-conformal calibration of the
 * same ratio (the nonconformity score) over the type's latest `recent`
 * (CONFORMAL_WINDOW) scored runs: its finite-sample quantile promises at least
 * 80% to the next run while recent runs are exchangeable with it, and the
 * window follows a change in the model mix. Both see only runs that ENDED
 * before the run started; the shape is not known at submit, so the group is
 * the task type known at submit. Per correction: coverage, the median slow
 * figure and the mean interval score; `better` says whether conformal clears
 * passesBar, the bar for using it live. `rows` are the held-out runs'
 * figures, in start order.
 * @param {ReadonlyArray<ReplayRun>} runs usable runs
 * @param {Parameters<typeof replay>[1] & { target?: number, minN?: number, recent?: number }} [options]
 * @returns {ConformalScore | null} null when nothing is held out
 */
export function scoreConformal(runs, options = {}) {
  const target = options.target ?? 0.8
  const rows = predictedRows(runs, { ...options, measure: 'time' })
  const cut = cutOf(rows)
  const test = rows.filter(r => r.startedAt >= cut)
  if (test.length === 0 || test.length === rows.length) return null
  const scoreOf = (/** @type {'fitted' | 'conformal'} */ name) => {
    const pairs = test.map(r => ({ slowMs: r.preds[name]?.slowMs ?? 0, actualMs: r.actualMs }))
    const hits = pairs.filter(p => p.actualMs <= p.slowMs).length
    const score = pairs.reduce((s, p) => s + intervalScore(p.slowMs, p.actualMs, target), 0) / pairs.length
    return { coverage: hits / pairs.length, hits, slowMs: median(pairs.map(p => p.slowMs)), score }
  }
  const fitted = scoreOf('fitted')
  const conformal = scoreOf('conformal')
  const better = passesBar(fitted, conformal, target)
  return {
    n: test.length,
    trainN: rows.length - test.length,
    recent: options.recent ?? CONFORMAL_WINDOW,
    fitted,
    conformal,
    better,
    rows: test.map(r => ({ runId: r.runId, actualMs: r.actualMs, fittedMs: r.preds.fitted?.slowMs ?? 0, conformalMs: r.preds.conformal?.slowMs ?? 0 })),
  }
}

/**
 * @typedef {{ key: string, n: number, hits: number, coverage: number | null }} DriftGroup
 */

/** A drift group needs this many runs before its coverage is compared. */
export const DRIFT_MIN_N = 30

/**
 * Does the slow figure hold as often in one month, or on one main model, as
 * in another? Each run is replayed at submit as in scoreRuns (uncorrected)
 * and its coverage grouped by the calendar month it started in (local time)
 * and by its main model. Drift is `yes` when two groups of at least
 * DRIFT_MIN_N runs have Wilson intervals that do not overlap, `no` when two or
 * more such groups exist and none do, and `unclear` when fewer than two
 * groups are big enough to compare.
 * @param {ReadonlyArray<ReplayRun>} runs usable runs
 * @param {Parameters<typeof replay>[1]} [options]
 * @returns {{ byMonth: DriftGroup[], byModel: DriftGroup[], drift: 'yes' | 'no' | 'unclear' }}
 */
export function scoreDrift(runs, options = {}) {
  const info = new Map(runs.map(r => [r.runId, r]))
  /** @type {Map<string, Map<string, { n: number, hits: number }>>} */
  const axes = new Map([['month', new Map()], ['model', new Map()]])
  for (const r of replay(runs, options)) {
    const run = info.get(r.runId)
    if (!r.submit || !run) continue
    const d = new Date(run.startedAt)
    const keys = [['month', `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`], ['model', run.model ?? 'unknown']]
    for (const [axis, key] of keys) {
      const groups = /** @type {Map<string, { n: number, hits: number }>} */ (axes.get(axis ?? ''))
      const g = groups.get(key ?? '') ?? { n: 0, hits: 0 }
      g.n += 1
      if (r.actualMs <= r.submit.slowMs) g.hits += 1
      groups.set(key ?? '', g)
    }
  }
  const list = (/** @type {string} */ axis) =>
    [...(axes.get(axis) ?? [])].map(([key, g]) => ({ key, n: g.n, hits: g.hits, coverage: g.n > 0 ? g.hits / g.n : null })).sort((a, b) => a.key.localeCompare(b.key))
  const byMonth = list('month')
  const byModel = list('model')
  // two groups of one axis are the comparison; a month and a model are not
  const comparable = [byMonth, byModel].some(axis => axis.filter(g => g.n >= DRIFT_MIN_N).length >= 2)
  const bigPairs = [byMonth, byModel].some(axis => {
    const ok = axis.filter(g => g.n >= DRIFT_MIN_N).map(g => ({ g, ci: wilson(g.hits, g.n) }))
    return ok.some(a => ok.some(b => a.ci && b.ci && a.ci.hi < b.ci.lo))
  })
  return { byMonth, byModel, drift: bigPairs ? 'yes' : comparable ? 'no' : 'unclear' }
}

/**
 * Coverage of the slow figure and typical miss of the usual one, per group,
 * over replayed rows that carry a `submit` or `step` figure (label-eval's
 * rows). A group's rows count as scored when the figure exists.
 * @param {ReadonlyArray<{ runId: string, actualMs: number } & { submit?: { usualMs: number, slowMs: number } | null, step?: { usualMs: number, slowMs: number } | null }>} rows
 * @param {(row: { runId: string }) => string | null} keyOf null leaves a row out
 * @param {'submit' | 'step'} field
 * @returns {Record<string, { runs: number, scored: number, hits: number, coverage: number | null, error: number | null }>}
 */
export function scoreSteps(rows, keyOf, field) {
  /** @type {Map<string, typeof rows[number][]>} */
  const groups = new Map()
  for (const r of rows) {
    const key = keyOf(r)
    if (key === null) continue
    const list = groups.get(key)
    if (list) list.push(r)
    else groups.set(key, [r])
  }
  /** @type {Record<string, { runs: number, scored: number, hits: number, coverage: number | null, error: number | null }>} */
  const out = {}
  for (const [key, list] of groups) {
    const ok = list.flatMap(r => (r[field] ? [{ usualMs: r[field].usualMs, slowMs: r[field].slowMs, actualMs: r.actualMs }] : []))
    const hits = ok.filter(p => p.actualMs <= p.slowMs).length
    out[key] = { runs: list.length, scored: ok.length, hits, coverage: ok.length === 0 ? null : hits / ok.length, error: typicalError(ok) }
  }
  return out
}
