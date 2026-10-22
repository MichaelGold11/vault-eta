// @ts-check
// From log rows to runs: one summary per run (a person's prompt with its
// subagents and the notification turns that came back to it), built the
// same way from live rows and backfilled ones.

import { SHAPE_STEPS, shapeOf } from './classify.mjs'
import { clip, lengthOf, subtract, union } from './spans.mjs'

/**
 * The fields of a log row this file reads (hooks/record.ts writes them).
 * @typedef {{ v?: number, kind?: string, src?: string, sessionId?: string, machineId?: string, runId: string, turnId?: string, agentId?: string | null, agentType?: string | null, background?: boolean | null, model?: string, effort?: string | number | null, start: number, end: number, ms?: number, agentMs?: number, waitMs?: number, sleepMs?: number, outcome?: string, usd?: number | null, unpriced?: boolean, tokens?: { input?: number, output?: number, cacheRead?: number, cacheWrite?: number }, steps?: unknown[], tools?: Array<{ at?: number, waitMs?: number }>, sleeps?: Array<[number, number]>, task?: { taskType?: string, skill?: string | null, command?: string | null, project?: string | null, job?: string | null, promptChars?: number, origin?: string } }} LogRow
 */

/**
 * @typedef {{ agentId: string, agentType: string, model: string, ms: number, usd: number | null, background: boolean }} RunAgent
 * @typedef {{ runId: string, sessionId: string, src: string, taskType: string, project: string | null, job: string | null, model: string | null, effort: string | number | null, promptChars: number, origin: string, shape: string, startedAt: number, endedAt: number, mainEndedAt: number, wallMs: number, agentMs: number, waitMs: number, sleepMs: number, usd: number | null, unpricedTurns: number, tokens: { input: number, output: number, cacheRead: number, cacheWrite: number }, turns: number, mainSteps: number, steps: number, subagents: RunAgent[], outcome: string, followedUp: boolean }} RunSummary
 */

export const FOLLOW_UP_MS = 120_000

/**
 * Rows of runs the live recorder logged win over backfilled rows of the
 * same run, and a turn logged twice (a file reloaded and rewritten) counts once.
 * @param {readonly LogRow[]} rows
 * @returns {LogRow[]}
 */
export function dedupeRuns(rows) {
  const turns = rows.filter(r => r && r.kind !== 'session' && typeof r.runId === 'string')
  const live = new Set(turns.filter(r => r.src !== 'backfill').map(r => r.runId))
  /** @type {Map<string, LogRow>} */
  const seen = new Map()
  for (const r of turns) {
    if (r.src === 'backfill' && live.has(r.runId)) continue
    seen.set(`${r.runId}|${r.agentId ?? 'main'}|${r.turnId ?? r.start}`, r)
  }
  return [...seen.values()]
}

/**
 * The spans of a row the person or a sleeping machine held, in clock time.
 * @param {LogRow} r
 * @returns {{ waits: Array<[number, number]>, sleeps: Array<[number, number]> }}
 */
function heldSpans(r) {
  /** @type {Array<[number, number]>} */
  const waits = []
  for (const t of r.tools ?? []) {
    if (t && typeof t.waitMs === 'number' && t.waitMs > 0) {
      const at = r.start + (t.at ?? 0)
      waits.push([at, at + t.waitMs])
    }
  }
  /** @type {Array<[number, number]>} */
  const sleeps = (r.sleeps ?? []).map(([at, ms]) => /** @type {[number, number]} */ ([r.start + at, r.start + at + ms]))
  return { waits, sleeps }
}


/**
 * What a run's main loop did in its first model requests, from its rows
 * alone (the same facts the live recorder keeps as it goes): each Skill
 * call with the request number it came in, and each tool call with its
 * request number and folder. Request numbers count from 1 across the run's
 * main turns. Names and folders only, never arguments.
 * @param {readonly LogRow[]} mainRows the run's main-loop rows
 * `stepStarts` are the clock times the main requests began, and `waits` the
 * person's holds as [clock time, ms], so the agent time gone before request
 * n is `agentMsBefore`.
 * @returns {{ startedAt: number, steps: number, skills: string[], skillSteps: number[], skillWork: number[], calls: Array<{ name: string, step: number, dir?: string }>, stepStarts: number[], waits: Array<[number, number]> }}
 */
export function earlyFacts(mainRows) {
  const rows = [...mainRows].filter(r => !r.agentId).sort((a, b) => a.start - b.start)
  /** @type {string[]} */
  const skills = []
  /** @type {number[]} */
  const skillSteps = []
  /** @type {number[]} */
  const skillWork = []
  let work = 0
  /** @type {Array<{ name: string, step: number, dir?: string }>} */
  const calls = []
  /** @type {number[]} */
  const stepStarts = []
  /** @type {Array<[number, number]>} */
  const waits = []
  let base = 0
  for (const r of rows) {
    const stepAts = (r.steps ?? []).map(s => /** @type {{ at?: number }} */ (s).at ?? 0)
    for (const at of stepAts) stepStarts.push(r.start + at)
    for (const t of /** @type {Array<{ at?: number, name?: string, skill?: string, dir?: string, waitMs?: number }>} */ (r.tools ?? [])) {
      if (typeof t.waitMs === 'number' && t.waitMs > 0) waits.push([r.start + (t.at ?? 0), t.waitMs])
      const step = base + Math.max(1, stepAts.filter(at => at <= (t.at ?? 0)).length)
      const name = String(t.name ?? 'tool')
      calls.push({ name, step, ...(t.dir ? { dir: t.dir } : {}) })
      if (name === 'Skill' && typeof t.skill === 'string') {
        skills.push(t.skill)
        skillSteps.push(step)
        skillWork.push(work)
      } else {
        work++
      }
    }
    base += stepAts.length
  }
  return { startedAt: rows[0]?.start ?? 0, steps: base, skills, skillSteps, skillWork, calls, stepStarts, waits }
}

/**
 * Agent time gone when the run's n-th main request began (1 for the first):
 * the clock time since the run started, less the person's holds that ended
 * before it. Null when the run had no such request.
 * @param {ReturnType<typeof earlyFacts>} facts
 * @param {number} n
 * @returns {number | null}
 */
export function agentMsBefore(facts, n) {
  const at = facts.stepStarts[n - 1]
  if (at === undefined) return null
  let held = 0
  for (const [from, ms] of facts.waits) held += Math.max(0, Math.min(from + ms, at) - from)
  return Math.max(0, at - facts.startedAt - held)
}

/**
 * The run's task as its rows last said it: the most specific task type
 * (anything over `freeform`), the newest row winning.
 * @param {readonly LogRow[]} rows newest last
 */
function taskOf(rows) {
  const withTask = rows.filter(r => r.task)
  const specific = [...withTask].reverse().find(r => r.task?.taskType && r.task.taskType !== 'freeform')
  const latest = withTask[withTask.length - 1]
  const t = (specific ?? latest)?.task ?? {}
  return {
    taskType: t.taskType ?? 'freeform',
    project: t.project ?? latest?.task?.project ?? null,
    job: t.job ?? null,
    promptChars: t.promptChars ?? 0,
    origin: t.origin ?? 'unknown',
  }
}

/**
 * One summary per run, oldest first. Agent time is the clock time any of the
 * run's loops was working, with waits on the person and machine sleep taken
 * out; parallel subagents count once.
 * @param {readonly LogRow[]} rows
 * @returns {RunSummary[]}
 */
export function groupByRun(rows) {
  /** @type {Map<string, LogRow[]>} */
  const byRun = new Map()
  for (const r of dedupeRuns(rows)) {
    if (!Number.isFinite(r.start) || !Number.isFinite(r.end)) continue
    byRun.set(r.runId, [...(byRun.get(r.runId) ?? []), r])
  }
  /** @type {RunSummary[]} */
  const runs = []
  for (const [runId, list] of byRun) {
    const sorted = [...list].sort((a, b) => a.end - b.end)
    const main = sorted.filter(r => !r.agentId)
    const first = [...sorted].sort((a, b) => a.start - b.start)[0]
    if (!first) continue
    /** @type {Array<[number, number]>} */
    const active = sorted.map(r => /** @type {[number, number]} */ ([r.start, r.end]))
    /** @type {Array<[number, number]>} */
    const waits = []
    /** @type {Array<[number, number]>} */
    const sleeps = []
    for (const r of sorted) {
      const held = heldSpans(r)
      waits.push(...held.waits)
      sleeps.push(...held.sleeps)
    }
    const activeU = union(active)
    const sleepIn = activeU.flatMap(w => clip(sleeps, w))
    const waitIn = subtract(activeU.flatMap(w => clip(waits, w)), sleeps)
    const agentMs = lengthOf(subtract(activeU, [...waitIn, ...sleepIn]))
    let usd = 0
    let unpricedTurns = 0
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    for (const r of sorted) {
      if (typeof r.usd === 'number') usd += r.usd
      else unpricedTurns += 1
      tokens.input += r.tokens?.input ?? 0
      tokens.output += r.tokens?.output ?? 0
      tokens.cacheRead += r.tokens?.cacheRead ?? 0
      tokens.cacheWrite += r.tokens?.cacheWrite ?? 0
    }
    /** @type {Map<string, RunAgent>} */
    const agents = new Map()
    for (const r of sorted) {
      if (!r.agentId) continue
      const a = agents.get(r.agentId) ?? { agentId: r.agentId, agentType: r.agentType ?? 'agent', model: r.model ?? '', ms: 0, usd: 0, background: Boolean(r.background) }
      a.ms += r.ms ?? r.end - r.start
      a.usd = a.usd === null || typeof r.usd !== 'number' ? null : a.usd + r.usd
      agents.set(r.agentId, a)
    }
    const task = taskOf(sorted)
    const shape = shapeOf(earlyFacts(main).calls.filter(c => c.step <= SHAPE_STEPS).map(c => c.name))
    const lead = main[0] ?? first
    const last = main[main.length - 1] ?? sorted[sorted.length - 1] ?? first
    const startedAt = first.start
    const endedAt = Math.max(...sorted.map(r => r.end))
    runs.push({
      runId,
      sessionId: lead.sessionId ?? '',
      src: lead.src ?? 'live',
      ...task,
      shape,
      model: lead.model ?? null,
      effort: lead.effort ?? null,
      startedAt,
      endedAt,
      mainEndedAt: main.length > 0 ? Math.max(...main.map(r => r.end)) : endedAt,
      wallMs: endedAt - startedAt,
      agentMs,
      waitMs: lengthOf(waitIn),
      sleepMs: lengthOf(sleepIn),
      usd: sorted.length > 0 && unpricedTurns === sorted.length ? null : usd,
      unpricedTurns,
      tokens,
      turns: sorted.length,
      mainSteps: main.reduce((s, r) => s + (r.steps?.length ?? 0), 0),
      steps: sorted.reduce((s, r) => s + (r.steps?.length ?? 0), 0),
      subagents: [...agents.values()],
      outcome: last.outcome ?? 'finished',
      followedUp: false,
    })
  }
  runs.sort((a, b) => a.startedAt - b.startedAt)
  markFollowUps(runs)
  return runs
}

/**
 * A run whose session got its next prompt within two minutes, in the same
 * project, was likely not done: `followedUp`.
 * @param {RunSummary[]} runs oldest first
 */
export function markFollowUps(runs) {
  /** @type {Map<string, RunSummary[]>} */
  const bySession = new Map()
  for (const r of runs) bySession.set(r.sessionId, [...(bySession.get(r.sessionId) ?? []), r])
  for (const list of bySession.values()) {
    for (let i = 0; i < list.length - 1; i++) {
      const run = list[i]
      const nextRun = list[i + 1]
      if (!run || !nextRun) continue
      const gap = nextRun.startedAt - run.mainEndedAt
      run.followedUp = gap >= 0 && gap <= FOLLOW_UP_MS && run.project === nextRun.project
    }
  }
}

/**
 * One summary per run for the profile and the report: its agent time is the
 * main loop's (the turns' agentMs, falling back to ms), never the clock span
 * across the run's rows, which holds waits and later notification turns;
 * background subagents count toward cost (usd sums every row), not time. The
 * estimate the run's main rows carry rides along.
 * @param {ReadonlyArray<LogRow & { eta?: unknown, etaMid?: unknown }>} rows
 * @returns {Array<RunSummary & { eta: any, etaMid: any }>}
 */
export function summarizeRuns(rows) {
  const eta = new Map()
  const mid = new Map()
  for (const r of rows) {
    if (r.agentId || r.kind === 'session') continue
    if (r.eta) eta.set(r.runId, r.eta)
    if (r.etaMid) mid.set(r.runId, r.etaMid)
  }
  /** @type {Map<string, number>} */
  const mainMs = new Map()
  for (const r of dedupeRuns(rows)) {
    if (r.agentId) continue
    const ms = typeof r.agentMs === 'number' ? r.agentMs : r.ms
    if (typeof ms === 'number' && Number.isFinite(ms)) mainMs.set(r.runId, (mainMs.get(r.runId) ?? 0) + ms)
  }
  return groupByRun(rows).map(s => ({ ...s, agentMs: mainMs.get(s.runId) ?? s.agentMs, eta: eta.get(s.runId) ?? null, etaMid: mid.get(s.runId) ?? null }))
}

/**
 * Each run's early facts and slash command from its main rows, for replaying
 * what an estimate knew after its first few requests.
 * @param {readonly LogRow[]} rows
 * @returns {Map<string, { facts: ReturnType<typeof earlyFacts>, command: string | null }>}
 */
export function earlyByRun(rows) {
  /** @type {Map<string, LogRow[]>} */
  const byRun = new Map()
  for (const r of dedupeRuns(rows)) if (!r.agentId) byRun.set(r.runId, [...(byRun.get(r.runId) ?? []), r])
  return new Map([...byRun].map(([id, list]) => [id, { facts: earlyFacts(list), command: list.map(r => r.task?.command ?? null).find(Boolean) ?? null }]))
}
