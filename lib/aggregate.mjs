// @ts-check
// From log rows to runs: one summary per run (a person's prompt with its
// subagents and the notification turns that came back to it), built the
// same way from live rows and backfilled ones.

import { EDIT_TOOLS, SHAPE_STEPS, SUBMIT_STEPS, classifyRun, shapeOf } from './classify.mjs'
import { clip, lengthOf, subtract, union } from './spans.mjs'

/**
 * The fields of a log row this file reads (hooks/record.ts writes them).
 * @typedef {{ v?: number, kind?: string, src?: string, sessionId?: string, machineId?: string, runId: string, turnId?: string, agentId?: string | null, agentType?: string | null, background?: boolean | null, model?: string, effort?: string | number | null, start: number, end: number, ms?: number, agentMs?: number, waitMs?: number, sleepMs?: number, outcome?: string, usd?: number | null, unpriced?: boolean, tokens?: { input?: number, output?: number, cacheRead?: number, cacheWrite?: number }, steps?: unknown[], tools?: Array<{ at?: number, waitMs?: number }>, sleeps?: Array<[number, number]>, task?: { taskType?: string, skill?: string | null, command?: string | null, project?: string | null, job?: string | null, promptChars?: number, origin?: string } }} LogRow
 */

/**
 * @typedef {{ agentId: string, agentType: string, model: string, ms: number, usd: number | null, background: boolean, startedAt: number, endedAt: number }} RunAgent
 * @typedef {{ runId: string, sessionId: string, src: string, taskType: string, project: string | null, submitTaskType: string, submitProject: string | null, job: string | null, model: string | null, effort: string | number | null, promptChars: number, origin: string, shape: string, startedAt: number, endedAt: number, mainEndedAt: number, mainLastAt: number, wallMs: number, agentMs: number, mainMs: number, waitMs: number, sleepMs: number, fellBack: number, usd: number | null, unpricedTurns: number, tokens: { input: number, output: number, cacheRead: number, cacheWrite: number }, turns: number, mainSteps: number, steps: number, subagents: RunAgent[], outcome: string, followedUp: boolean }} RunSummary
 * `taskType` and `project` are the run's own labels, as its rows last said
 * them; `submitTaskType` and `submitProject` are the ones known when its
 * estimate at submit was made (summarizeRuns, labelsAtSubmit).
 */

export const FOLLOW_UP_MS = 120_000

/**
 * How far a live row's window, less its own waits and sleep, may stray from
 * the time it stored and still be where its loop worked: a row the recorder
 * wrote gives its time back to within rounding.
 */
export const PLACE_TOLERANCE_MS = 1000

/**
 * A stretch this long in a backfilled row with no model request or tool call
 * in flight is a join between turns, not work. A live turn never has one
 * past a minute; a backfilled row joins every turn of its loop under one
 * window, so its notification turns and an agent's resumed turns leave them.
 */
export const IDLE_CUT_MS = 600_000

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
 * A row's own stored time: its agentMs, else its ms; null when it has neither.
 * @param {LogRow} r
 * @returns {number | null}
 */
function storedMs(r) {
  const ms = typeof r.agentMs === 'number' ? r.agentMs : r.ms
  return typeof ms === 'number' && Number.isFinite(ms) ? Math.max(0, ms) : null
}

/**
 * Where a row's loop worked on the clock, before waits and sleep come out. A
 * live row is one turn the recorder saw open from start to end: its window. A
 * backfilled row joins every turn of its loop under one window (a main row's
 * notification turns, an agent's resumed turns), so any stretch of it over
 * IDLE_CUT_MS with no model request or tool call in flight is cut out: a turn
 * had ended there, which the live recorder knew as it happened and the
 * backfilled row keeps no mark of. A request counts from its first line, up
 * to the next request's.
 * @param {LogRow} r
 * @returns {Array<[number, number]>}
 */
function workSpans(r) {
  const window = /** @type {[number, number]} */ ([r.start, r.end])
  if (r.src !== 'backfill') return [window]
  const steps = /** @type {Array<{ at?: number, ms?: number }>} */ (r.steps ?? []).map(s => ({ at: s.at ?? 0, ms: s.ms ?? 0 })).sort((a, b) => a.at - b.at)
  /** @type {Array<[number, number]>} */
  const busy = steps.map((s, i) => [r.start + s.at, r.start + Math.min(s.at + s.ms, steps[i + 1]?.at ?? Infinity)])
  for (const t of /** @type {Array<{ at?: number, ms?: number }>} */ (r.tools ?? [])) busy.push([r.start + (t.at ?? 0), r.start + (t.at ?? 0) + (t.ms ?? 0)])
  const idle = subtract([window], busy).filter(([from, to]) => to - from > IDLE_CUT_MS)
  return subtract([window], idle)
}

/**
 * Whether a row can be placed on the clock. A backfilled row always can, by
 * its timestamps (workSpans). A live row can when its window, less its own
 * waits and sleep, gives back the time it stored; one written before the
 * recorder kept a turn's own start took its window from the engine's turn
 * time, which leaves out a permission prompt or a question, so a long wait
 * lies partly outside it and the window cannot be trusted. A row with no
 * agentMs is held to its ms, the window's own length.
 * @param {LogRow} r
 * @returns {boolean}
 */
export function isPlaced(r) {
  if (r.src === 'backfill') return true
  const window = /** @type {[number, number]} */ ([r.start, r.end])
  if (typeof r.agentMs !== 'number' || !Number.isFinite(r.agentMs)) {
    return typeof r.ms !== 'number' || !Number.isFinite(r.ms) || Math.abs(r.end - r.start - r.ms) <= PLACE_TOLERANCE_MS
  }
  const held = heldSpans(r)
  const own = lengthOf(subtract([window], [...clip(held.waits, window), ...clip(held.sleeps, window)]))
  return Math.abs(own - r.agentMs) <= PLACE_TOLERANCE_MS
}

/**
 * A run's time, on the one clock the band, the log, the report and the
 * replay share: the clock time any of its loops was working (the main loop
 * and every subagent, background ones included, parallel ones counted once),
 * less waits on the person and machine sleep. A row that cannot be placed on
 * the clock (isPlaced) adds its own stored time whole, taken as overlapping
 * nothing else; `fellBack` counts those rows. `mainMs` is the main loop's part.
 * @param {readonly LogRow[]} rows one run's rows
 * @returns {{ agentMs: number, mainMs: number, waitMs: number, sleepMs: number, fellBack: number }}
 */
export function runClock(rows) {
  /** @type {LogRow[]} */
  const placed = []
  /** @type {LogRow[]} */
  const unplaced = []
  for (const r of rows) (isPlaced(r) ? placed : unplaced).push(r)
  /** @type {Array<[number, number]>} */
  const waits = []
  /** @type {Array<[number, number]>} */
  const sleeps = []
  for (const r of placed) {
    const held = heldSpans(r)
    waits.push(...held.waits)
    sleeps.push(...held.sleeps)
  }
  const windows = (/** @type {readonly LogRow[]} */ list) => union(list.flatMap(workSpans))
  const active = windows(placed)
  const sleepIn = active.flatMap(w => clip(sleeps, w))
  const waitIn = subtract(active.flatMap(w => clip(waits, w)), sleeps)
  const held = [...waitIn, ...sleepIn]
  const sum = (/** @type {readonly LogRow[]} */ list, /** @type {(r: LogRow) => number} */ of) => list.reduce((s, r) => s + of(r), 0)
  const own = (/** @type {LogRow} */ r) => storedMs(r) ?? 0
  return {
    agentMs: lengthOf(subtract(active, held)) + sum(unplaced, own),
    mainMs: lengthOf(subtract(windows(placed.filter(r => !r.agentId)), held)) + sum(unplaced.filter(r => !r.agentId), own),
    waitMs: lengthOf(waitIn) + sum(unplaced, r => Math.max(0, r.waitMs ?? 0)),
    sleepMs: lengthOf(sleepIn) + sum(unplaced, r => Math.max(0, r.sleepMs ?? 0)),
    fellBack: unplaced.length,
  }
}

/**
 * Where a run's loops worked on the clock, waits on the person and sleep cut
 * out: their length up to a moment is the run time gone by then, as the band
 * showed it. Nothing past that moment counts toward it; a backfilled row's
 * long quiet stretch is cut whole (workSpans), as the turn that ended there
 * was over when it ended. A row that cannot be placed is taken at its window
 * here too: the replay has nothing better for it, and a run's early requests
 * fall in its first turn, where the window holds.
 * @param {readonly LogRow[]} rows one run's rows
 * @returns {Array<[number, number]>}
 */
function workedSpans(rows) {
  /** @type {Array<[number, number]>} */
  const held = []
  for (const r of rows) {
    const h = heldSpans(r)
    held.push(...h.waits, ...h.sleeps)
  }
  return subtract(rows.flatMap(workSpans), held)
}


/**
 * What a run's main loop did in its first model requests, from its rows
 * alone (the same facts the live recorder keeps as it goes): each Skill
 * call with the request number it came in, and each tool call with its
 * request number and folder. Request numbers count from 1 across the run's
 * main turns. Names and folders only, never arguments.
 * @param {readonly LogRow[]} runRows the run's rows; the facts are the main
 * loop's, and the subagents' rows count only toward `worked`
 * `stepStarts` are the clock times the main requests began, and `worked` the
 * spans any of the run's loops worked (waits and sleep cut out), so the run
 * time gone before request n is `agentMsBefore`.
 * @returns {{ startedAt: number, steps: number, skills: string[], skillSteps: number[], skillWork: number[], calls: Array<{ name: string, step: number, dir?: string }>, stepStarts: number[], worked: Array<[number, number]> }}
 */
export function earlyFacts(runRows) {
  const rows = [...runRows].filter(r => !r.agentId).sort((a, b) => a.start - b.start)
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
  let base = 0
  for (const r of rows) {
    const stepAts = (r.steps ?? []).map(s => /** @type {{ at?: number }} */ (s).at ?? 0)
    for (const at of stepAts) stepStarts.push(r.start + at)
    for (const t of /** @type {Array<{ at?: number, name?: string, skill?: string, dir?: string }>} */ (r.tools ?? [])) {
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
  const startedAt = rows[0]?.start ?? Math.min(...runRows.map(r => r.start))
  return { startedAt: Number.isFinite(startedAt) ? startedAt : 0, steps: base, skills, skillSteps, skillWork, calls, stepStarts, worked: workedSpans(runRows) }
}

/**
 * Run time gone when the run's n-th main request began (1 for the first), on
 * the run clock: the time any of its loops had worked by then, waits on the
 * person and sleep left out. Null when the run had no such request.
 * @param {ReturnType<typeof earlyFacts>} facts
 * @param {number} n
 * @returns {number | null}
 */
export function agentMsBefore(facts, n) {
  const at = facts.stepStarts[n - 1]
  if (at === undefined) return null
  return lengthOf(clip(facts.worked, [facts.startedAt, at]))
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
 * The task type and project known when a run's estimate at submit was made,
 * by the rule the live estimate follows, from the run's own rows: it is made
 * as the prompt is sent and refreshed through the first SUBMIT_STEPS main
 * requests, so it knows the slash command and the skills loaded and folders
 * touched in those requests, and nothing later. For a run that kept no
 * estimate of its own (a backfilled run, or one logged before the estimate
 * was kept). The labels are read from those facts (classifyRun with its
 * default settings) and kept only where they agree with the run's own labels,
 * which were made under the settings in force when it was logged (skills to
 * ignore, the projects folder): a task type they do not reach is the slash
 * command or freeform, as before any skill loads, and a project they do not
 * reach is none. So the labels are never better informed than live was, and a
 * setting is never second-guessed; a label the rows cannot explain (no Skill
 * call or command names it) counts as unknown at submit.
 * @param {ReturnType<typeof earlyFacts>} facts the run's main loop's
 * @param {string | null} command the slash command, as its rows keep it (an ignored one is none)
 * @param {{ taskType: string, project: string | null }} own the run's own labels
 * @returns {{ taskType: string, project: string | null }}
 */
export function labelsAtSubmit(facts, command, own) {
  const idx = facts.skillSteps.flatMap((step, i) => (step <= SUBMIT_STEPS ? [i] : []))
  const calls = facts.calls.filter(c => c.step <= SUBMIT_STEPS)
  const early = classifyRun({
    skills: idx.map(i => facts.skills[i] ?? ''),
    skillWork: idx.map(i => facts.skillWork[i] ?? 0),
    command,
    editedPaths: calls.flatMap(c => (EDIT_TOOLS.has(c.name) && c.dir ? [c.dir] : [])),
    readPaths: calls.flatMap(c => (c.name === 'Read' && c.dir ? [c.dir] : [])),
  })
  const bare = command ? String(command).replace(/^\//, '') : null
  return {
    taskType: early.taskType === own.taskType ? own.taskType : (bare ?? 'freeform'),
    project: early.project !== null && early.project === own.project ? own.project : null,
  }
}

/**
 * When a main row last did anything: its end, or the end of its last model
 * request when that is later (a backfilled row's end can stop short of the
 * requests a later notification brought).
 * @param {LogRow} r
 * @returns {number}
 */
function lastActivity(r) {
  let last = r.end
  for (const s of /** @type {Array<{ at?: number, ms?: number }>} */ (r.steps ?? [])) last = Math.max(last, r.start + (s.at ?? 0) + (s.ms ?? 0))
  return last
}

/**
 * One summary per run, oldest first. Its agent time is the run clock's
 * (runClock): the clock time any of the run's loops was working, waits on the
 * person and machine sleep taken out, parallel subagents counted once.
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
    const clock = runClock(sorted)
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
      const a = agents.get(r.agentId) ?? { agentId: r.agentId, agentType: r.agentType ?? 'agent', model: r.model ?? '', ms: 0, usd: 0, background: Boolean(r.background), startedAt: r.start, endedAt: r.end }
      a.ms += r.ms ?? r.end - r.start
      a.usd = a.usd === null || typeof r.usd !== 'number' ? null : a.usd + r.usd
      a.startedAt = Math.min(a.startedAt, r.start)
      a.endedAt = Math.max(a.endedAt, r.end)
      agents.set(r.agentId, a)
    }
    const task = taskOf(sorted)
    const facts = earlyFacts(main)
    const shape = shapeOf(facts.calls.filter(c => c.step <= SHAPE_STEPS).map(c => c.name))
    const command = main.map(r => r.task?.command ?? null).find(Boolean) ?? null
    const atSubmit = labelsAtSubmit(facts, command, task)
    const lead = main[0] ?? first
    const last = main[main.length - 1] ?? sorted[sorted.length - 1] ?? first
    const startedAt = first.start
    const endedAt = Math.max(...sorted.map(r => r.end))
    runs.push({
      runId,
      sessionId: lead.sessionId ?? '',
      src: lead.src ?? 'live',
      ...task,
      submitTaskType: atSubmit.taskType,
      submitProject: atSubmit.project,
      shape,
      model: lead.model ?? null,
      effort: lead.effort ?? null,
      startedAt,
      endedAt,
      mainEndedAt: main.length > 0 ? Math.max(...main.map(r => r.end)) : endedAt,
      mainLastAt: main.length > 0 ? Math.max(...main.map(lastActivity)) : endedAt,
      wallMs: endedAt - startedAt,
      agentMs: clock.agentMs,
      mainMs: clock.mainMs,
      waitMs: clock.waitMs,
      sleepMs: clock.sleepMs,
      fellBack: clock.fellBack,
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
 * One summary per run for the profile, the report and the replay, its time on
 * the run clock (runClock: the main loop and its subagents, background ones
 * included, the same clock the band counts), its cost summed over every row.
 * The estimate the run's main rows carry rides along, and its labels are the
 * run's labels at submit (`submitTaskType`, `submitProject`): what that
 * estimate knew. A run that kept no estimate (backfilled, or logged before
 * the estimate was kept) has them by the same rule from its rows instead
 * (labelsAtSubmit).
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
  return groupByRun(rows).map(s => {
    const kept = eta.get(s.runId) ?? null
    const known = kept && typeof kept.taskType === 'string' ? { submitTaskType: kept.taskType, submitProject: typeof kept.project === 'string' ? kept.project : null } : {}
    return { ...s, ...known, eta: kept, etaMid: mid.get(s.runId) ?? null }
  })
}

/**
 * Each run's early facts (from all its rows: the main loop's requests and
 * calls, every loop's time) and slash command, for replaying what an
 * estimate knew after its first few requests.
 * @param {readonly LogRow[]} rows
 * @returns {Map<string, { facts: ReturnType<typeof earlyFacts>, command: string | null }>}
 */
export function earlyByRun(rows) {
  /** @type {Map<string, LogRow[]>} */
  const byRun = new Map()
  for (const r of dedupeRuns(rows)) {
    if (!Number.isFinite(r.start) || !Number.isFinite(r.end)) continue
    byRun.set(r.runId, [...(byRun.get(r.runId) ?? []), r])
  }
  return new Map([...byRun].map(([id, list]) => [id, { facts: earlyFacts(list), command: list.filter(r => !r.agentId).map(r => r.task?.command ?? null).find(Boolean) ?? null }]))
}
