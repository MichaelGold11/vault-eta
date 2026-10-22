// @ts-check
// Plain statistics over past runs: no model calls, no tokens. Matching with
// fallback, the usual (median) and slow (p80) figures, the remaining time
// given how long a run has gone, progress from steps and task lists, today's
// model speed, and the self-score that widens or tightens the slow figure.

/**
 * @typedef {{ taskType: string, project: string | null, model: string | null, effort?: string | number | null, promptChars?: number, size?: string, shape?: string | null, prevProject?: string | null, origin?: string, agentMs: number, usd: number | null, endedAt: number, mainSteps?: number }} PastRun
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
 * The self-score for one kind of estimate: how often the actual time came in
 * under the slow figure, and the factor that would have put `target` of them
 * under it (the target-quantile of actual over slow). Under `minN` scored
 * runs the factor stays 1.
 * @param {ReadonlyArray<{ slowMs: number, actualMs: number }>} scored
 * @param {{ target?: number, minN?: number }} [options]
 * @returns {{ n: number, coverage: number | null, factor: number }}
 */
export function calibrate(scored, options = {}) {
  const target = options.target ?? 0.8
  const minN = options.minN ?? 5
  const ok = scored.filter(s => s.slowMs > 0 && Number.isFinite(s.actualMs))
  if (ok.length === 0) return { n: 0, coverage: null, factor: 1 }
  const coverage = ok.filter(s => s.actualMs <= s.slowMs).length / ok.length
  if (ok.length < minN) return { n: ok.length, coverage, factor: 1 }
  const factor = quantile(ok.map(s => s.actualMs / s.slowMs), target) ?? 1
  return { n: ok.length, coverage, factor: Math.min(4, Math.max(0.5, factor)) }
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
 * @typedef {PastRun & { runId: string, startedAt: number }} ReplayRun
 * @typedef {{ runId: string, taskType: string, startedAt: number, actualMs: number, level: string | null, n: number, submit: { usualMs: number, slowMs: number } | null }} Replayed
 */

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
 * `queryOf` says what the estimate knew when it was made (default: the run's
 * own task type, project, model, effort and prompt size; its shape only shows
 * after the second request, so it is left out), so a replay can be held to
 * what is known at submit.
 * @param {readonly ReplayRun[]} runs
 * @param {{ minMatches?: number, limit?: number, slowFactor?: number, levels?: readonly Level[], queryOf?: (run: ReplayRun) => RunQuery, window?: number }} [options]
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
    const query = options.queryOf ? options.queryOf(run) : { ...run, shape: undefined }
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
    out.push({ runId: run.runId, taskType: run.taskType, startedAt: run.startedAt, actualMs: run.agentMs, level: match.level, n: match.runs.length, submit })
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
 * @param {ReadonlyArray<ReplayRun & { eta?: { usualMs: number | null, slowMs: number | null } | null, etaMid?: { usualMs: number, slowMs: number } | null }>} runs usable runs
 * @param {{ target?: number, minN?: number, minMatches?: number, limit?: number, levels?: readonly Level[], queryOf?: (run: ReplayRun) => RunQuery, window?: number }} [options]
 * @returns {Record<string, TypeScore>}
 */
export function scoreRuns(runs, options = {}) {
  const mids = new Map(runs.flatMap(r => (r.etaMid ? [[r.runId, { usualMs: r.etaMid.usualMs, slowMs: r.etaMid.slowMs }]] : [])))
  const replayed = replay(runs, options)
  const base = scoreByType(replayed.map(r => ({ taskType: r.taskType, actualMs: r.actualMs, submit: r.submit, step: mids.get(r.runId) ?? null })), options)
  /** @type {Map<string, Array<{ slowMs: number, actualMs: number }>>} */
  const shown = new Map()
  for (const r of runs) {
    if (!r.eta || r.eta.usualMs === null || r.eta.slowMs === null) continue
    const list = shown.get(r.taskType)
    const entry = { slowMs: r.eta.slowMs, actualMs: r.agentMs }
    if (list) list.push(entry)
    else shown.set(r.taskType, [entry])
  }
  /** @type {Map<string, { submit: Array<{ usualMs: number, actualMs: number }>, step: Array<{ usualMs: number, actualMs: number }> }>} */
  const paired = new Map()
  for (const r of replayed) {
    const step = mids.get(r.runId)
    if (!r.submit || !step) continue
    const p = paired.get(r.taskType) ?? { submit: [], step: [] }
    p.submit.push({ usualMs: r.submit.usualMs, actualMs: r.actualMs })
    p.step.push({ usualMs: step.usualMs, actualMs: r.actualMs })
    paired.set(r.taskType, p)
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
