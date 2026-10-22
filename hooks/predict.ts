import { summarizeRuns } from '../lib/aggregate.mjs'
import { modelKey } from '../lib/price.mjs'
import {
  combineRemaining,
  estimateAtSubmit,
  matchRuns,
  median,
  remainingAfter,
  scoreRuns,
  speedFactor,
  stepFraction,
  taskFraction,
} from '../lib/stats.mjs'
import type { Match, PastRun, RunQuery, TypeScore } from '../lib/stats.mjs'
import type { EtaCost, EtaState, EtaTotals } from '../types'
import type { LiveView, MidEta, StoredEta, TurnRow } from './record'

// The profile and the estimate. At session start the last 90 days of rows
// (live and backfilled) become one summary per run; this session's rows join
// as they are written. An estimate matches past runs like this one (lib/stats),
// then refines the time left from how long the run has gone, its steps and
// task list, today's writing speed and the self-score. Plain statistics, no
// model calls.

export const MIN_MATCHES = 5
export const MATCH_LIMIT = 50
/** Writing speeds kept per model, newest first. */
const TPS_KEEP = 300
/** Writing speeds of the session's latest requests that count as "today's speed". */
const RECENT_TPS = 10

export type ProfileRun = PastRun & {
  runId: string
  sessionId: string
  /** Its rows, and how many of them had no price (a model missing from the price table). */
  turns: number
  unpricedTurns: number
  job: string | null
  startedAt: number
  outcome: string
  eta: StoredEta | null
  etaMid: MidEta | null
}

export type Estimate = {
  query: RunQuery
  learning: { have: number; need: number } | null
  level: string | null
  n: number
  submit: { usualMs: number; slowMs: number; usualUsd: number | null; slowUsd: number | null } | null
  factor: number
  coverage: number | null
  scored: number
  state: EtaState
  leftMs: number | null
  leftSlowMs: number | null
  totalMs: number | null
  speed: { tps: number | null; usualTps: number | null; etaPct: number | null }
}

export { modelKey }

function toRun(s: ReturnType<typeof summarizeRuns>[number]): ProfileRun {
  return {
    runId: s.runId,
    sessionId: s.sessionId,
    turns: s.turns,
    unpricedTurns: s.unpricedTurns,
    taskType: s.taskType,
    project: s.project,
    model: modelKey(s.model),
    effort: s.effort,
    promptChars: s.promptChars,
    shape: s.shape,
    agentMs: s.agentMs,
    usd: s.usd,
    endedAt: s.endedAt,
    startedAt: s.startedAt,
    mainSteps: s.mainSteps,
    job: s.job,
    outcome: s.outcome,
    eta: s.eta,
    etaMid: s.etaMid,
  }
}

/** One summary per run, with the estimate its main rows carry (lib/aggregate). */
function runsOf(rows: readonly TurnRow[]): ProfileRun[] {
  return summarizeRuns(rows as never).map(toRun)
}

/** Runs an estimate can learn from: finished, with time on the clock. */
function isUsable(r: ProfileRun): boolean {
  return r.outcome === 'finished' && r.agentMs > 0
}

export class Profile {
  /** Runs of other sessions (and every backfilled run), from the rows loaded at session start. */
  history: ProfileRun[] = []
  /** This session's runs, rebuilt from its rows as they are written. */
  session: ProfileRun[] = []
  sessionRows: TurnRow[] = []
  rowsLoaded = 0
  backfillRows = 0
  /** Median share of a run's agent time spent in model requests. */
  modelShare = 0.6
  /** Bumped at every change; the match cache keys on it. */
  version = 0
  private tps = new Map<string, number[]>()
  private matches = new Map<string, Match>()
  private scores: Record<string, TypeScore> | null = null
  /** Rows arrived since the scores were made: refreshScores makes them again while nothing runs, never on every row. */
  private isScoreStale = false

  load(rows: readonly TurnRow[], sessionId: string) {
    const isMine = (r: TurnRow) => r.sessionId === sessionId && (r.src as string) !== 'backfill'
    this.rowsLoaded = rows.length
    this.backfillRows = rows.filter(r => (r.src as string) === 'backfill').length
    this.sessionRows = rows.filter(isMine)
    const mineRuns = new Set(this.sessionRows.map(r => r.runId))
    this.history = runsOf(rows.filter(r => !isMine(r))).filter(r => !mineRuns.has(r.runId))
    this.tps = new Map()
    for (const r of [...rows].sort((a, b) => b.end - a.end)) this.learnSpeed(r, false)
    const shares = rows
      .filter(r => !r.agentId && r.agentMs > 1000 && r.modelMs > 0)
      .map(r => Math.min(1, r.modelMs / r.agentMs))
    this.modelShare = Math.max(0.05, Math.min(1, median(shares) ?? 0.6))
    this.rebuild()
    this.scores = null
    this.isScoreStale = false
  }

  /** A row this session just wrote. */
  addRow(row: TurnRow) {
    this.sessionRows.push(row)
    this.learnSpeed(row, true)
    this.rebuild()
  }

  private rebuild() {
    this.session = runsOf(this.sessionRows)
    const mine = new Set(this.session.map(r => r.runId))
    if (this.history.some(r => mine.has(r.runId))) this.history = this.history.filter(r => !mine.has(r.runId))
    this.version += 1
    this.matches.clear()
    if (this.scores) this.isScoreStale = true
  }

  /** Writing speeds per model; a backfilled step has none (null), and is skipped. */
  private learnSpeed(row: TurnRow, isNewest: boolean) {
    for (const s of row.steps ?? []) {
      const tps = s.tokensPerSec
      if (typeof tps !== 'number' || !(tps > 0)) continue
      const key = modelKey(s.model ?? row.model)
      if (key === null) continue
      const list = this.tps.get(key) ?? []
      if (isNewest) list.unshift(tps)
      else if (list.length < TPS_KEEP) list.push(tps)
      if (list.length > TPS_KEEP) list.length = TPS_KEEP
      this.tps.set(key, list)
    }
  }

  usualTps(model: string | null | undefined): number | null {
    const key = modelKey(model)
    return key === null ? null : median(this.tps.get(key) ?? [])
  }

  /** The session's latest writing speeds on the model, newest last. */
  recentTps(model: string | null | undefined): number[] {
    const key = modelKey(model)
    if (key === null) return []
    const out: number[] = []
    for (let i = this.sessionRows.length - 1; i >= 0 && out.length < RECENT_TPS; i--) {
      const row = this.sessionRows[i]
      if (!row || row.agentId) continue
      const steps = row.steps ?? []
      for (let j = steps.length - 1; j >= 0 && out.length < RECENT_TPS; j--) {
        const s = steps[j]
        if (s && typeof s.tokensPerSec === 'number' && s.tokensPerSec > 0 && modelKey(s.model ?? row.model) === key) out.unshift(s.tokensPerSec)
      }
    }
    return out
  }

  /** Every run known, this session's last. */
  runs(): ProfileRun[] {
    return [...this.history, ...this.session]
  }

  match(query: RunQuery, excludeRunId: string | null): Match {
    const key = `${this.version}|${excludeRunId ?? ''}|${JSON.stringify(query)}`
    const held = this.matches.get(key)
    if (held) return held
    const pool = this.runs().filter(r => r.runId !== excludeRunId && isUsable(r))
    const found = matchRuns(pool, query, { minMatches: MIN_MATCHES, limit: MATCH_LIMIT })
    if (this.matches.size > 50) this.matches.clear()
    this.matches.set(key, found)
    return found
  }

  /**
   * Per task type: how often the slow figure held, its correction, and which
   * estimate missed by less. Scored by replaying every run against only the
   * runs that ended before it (uncorrected), so there is data from day one;
   * what live runs actually showed is scored apart (`shown`). Computed at
   * load, then again by refreshScores while idle.
   */
  score(): Record<string, TypeScore> {
    if (this.scores) return this.scores
    this.scores = scoreRuns(this.runs().filter(isUsable), { minMatches: MIN_MATCHES, limit: MATCH_LIMIT })
    this.isScoreStale = false
    return this.scores
  }

  /**
   * Makes the scores again when rows have arrived since they were made. The
   * caller runs it while no run works (the idle view), so a run's own steps
   * never wait on a replay. Returns whether it ran.
   */
  refreshScores(): boolean {
    if (!this.isScoreStale) return false
    this.scores = null
    this.score()
    return true
  }

  /** The newest finished run: this session's first, else the last one logged before it. */
  lastRun(excludeRunId: string | null): ProfileRun | null {
    const pick = (list: ProfileRun[]) => {
      let best: ProfileRun | null = null
      for (const r of list) if (r.runId !== excludeRunId && (!best || r.endedAt > best.endedAt)) best = r
      return best
    }
    return pick(this.session) ?? pick(this.history)
  }

  totals(filter: (r: ProfileRun) => boolean): EtaTotals {
    const out: EtaTotals = { runs: 0, ms: 0, cost: { usd: 0, priced: 0, unpriced: 0 } }
    for (const r of this.runs()) {
      if (!filter(r)) continue
      const c = costOfRun(r)
      out.runs += 1
      out.ms += r.agentMs
      out.cost.usd += c.usd
      out.cost.priced += c.priced
      out.cost.unpriced += c.unpriced
    }
    return out
  }
}

/** A logged run's cost: its turns with a price, and those without. */
export function costOfRun(run: ProfileRun): EtaCost {
  const unpriced = run.unpricedTurns ?? 0
  return { usd: run.usd ?? 0, priced: Math.max(0, (run.turns ?? 1) - unpriced), unpriced }
}

/** Local midnight of the day `now` falls on. */
export function startOfDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** The query a running run is matched by. */
export function queryOf(live: LiveView): RunQuery {
  return {
    taskType: live.task?.taskType ?? 'freeform',
    project: live.task?.project ?? null,
    model: modelKey(live.model),
    effort: live.effort,
    promptChars: live.promptChars,
    shape: live.shape,
  }
}

/**
 * The estimate for the running run: at submit from its matches, then the
 * time left given how long it has gone (agent time, waits on the person
 * paused out), refined by steps, the task list and today's speed.
 */
export function estimateRun(profile: Profile, live: LiveView): Estimate {
  const query = queryOf(live)
  const match = profile.match(query, live.runId)
  const score = profile.score()[query.taskType]
  const factor = score?.factor ?? 1
  const sub = estimateAtSubmit(match, { slowFactor: factor })

  // Today's speed against the usual: the session's latest requests on this model, this run's last.
  const recent = [...profile.recentTps(live.model), ...live.recentTps].slice(-RECENT_TPS)
  const usualTps = profile.usualTps(live.model)
  const recentMedian = median(recent)
  const speed = speedFactor(recent, usualTps)
  const share = profile.modelShare
  const etaPct = recentMedian !== null && usualTps !== null ? Math.round((share * speed + (1 - share) - 1) * 100) : null
  const speedOut = { tps: recentMedian === null ? null : Math.round(recentMedian), usualTps: usualTps === null ? null : Math.round(usualTps), etaPct }

  const base = { query, level: match.level, n: match.runs.length, factor, coverage: score && score.n >= MIN_MATCHES ? score.coverage : null, scored: score?.n ?? 0, speed: speedOut }
  if (sub.learning || sub.usualMs === null || sub.slowMs === null) {
    return { ...base, learning: sub.learning ?? { have: match.runs.length, need: MIN_MATCHES }, submit: null, state: 'learning', leftMs: null, leftSlowMs: null, totalMs: null }
  }

  const usual = sub.usualMs
  const slow = sub.slowMs
  const elapsed = live.agentMs
  const survivors = remainingAfter(match.runs, elapsed)
  const usualSteps = median(match.runs.map(r => r.mainSteps ?? 0).filter(n => n > 0))
  const combined = combineRemaining({
    elapsedMs: elapsed,
    survivors,
    taskFraction: taskFraction(live.tasks.done, live.tasks.total),
    stepFraction: stepFraction(live.mainSteps, usualSteps),
    speed,
    modelShare: share,
  })
  let leftMs = combined.usualMs
  let leftSlowMs = combined.slowMs
  // Where the estimate at submit has missed by less for this task type, it leads while it still can.
  if (score && score.best === 'submit' && score.n >= MIN_MATCHES && usual > elapsed) {
    leftMs = usual - elapsed
    leftSlowMs = Math.max(leftMs, slow - elapsed)
  }
  if (leftMs === null && usual > elapsed) {
    leftMs = usual - elapsed
    leftSlowMs = Math.max(leftMs, slow - elapsed)
  }
  if (leftMs !== null && !(leftMs > 0)) {
    leftMs = null
    leftSlowMs = null
  }
  const state: EtaState = elapsed > slow ? 'past-slow' : elapsed > usual ? 'past-usual' : 'on-track'
  return {
    ...base,
    learning: null,
    submit: { usualMs: usual, slowMs: slow, usualUsd: sub.usualUsd, slowUsd: sub.slowUsd },
    state,
    leftMs,
    leftSlowMs,
    totalMs: leftMs !== null ? elapsed + leftMs : usual,
  }
}

/** What a run's rows keep of the estimate it began with. */
export function storedEta(est: Estimate, steps: number): StoredEta {
  return {
    taskType: est.query.taskType,
    project: est.query.project ?? null,
    model: est.query.model ?? null,
    level: est.level,
    n: est.n,
    learning: est.learning,
    usualMs: est.submit ? Math.round(est.submit.usualMs) : null,
    slowMs: est.submit ? Math.round(est.submit.slowMs) : null,
    usualUsd: est.submit?.usualUsd ?? null,
    slowUsd: est.submit?.slowUsd ?? null,
    factor: Math.round(est.factor * 1000) / 1000,
    steps,
  }
}
