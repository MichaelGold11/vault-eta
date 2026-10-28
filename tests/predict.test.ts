import { describe, expect, test } from 'claude-code/testing'

import { Profile, estimateRun, storedEta } from '../hooks/predict'
import type { LiveView, TurnRow } from '../hooks/record'
import { idleView } from '../hooks/view'

// The profile from rows, and the estimate for a running run, without the engine.

const T0 = new Date(2026, 9, 18, 12, 0, 0).getTime()
const DAY = 86_400_000
const OPUS = 'claude-opus-5-5'

type RowIn = { runId: string; taskType?: string; project?: string | null; seconds: number; src?: 'live' | 'backfill'; sessionId?: string; tps?: number | null; start?: number; steps?: number; eta?: TurnRow['eta']; tools?: TurnRow['tools'] }

function row(r: RowIn): TurnRow {
  const start = r.start ?? T0 - DAY
  const ms = r.seconds * 1000
  const steps = Array.from({ length: r.steps ?? 4 }, (_, i) => ({
    at: i * 1000,
    ms: 1000,
    firstTokenMs: r.src === 'backfill' ? null : 300,
    tokensPerSec: r.tps === undefined ? (r.src === 'backfill' ? null : 100) : r.tps,
    tokens: { input: 10, output: 100, cacheRead: 1000, cacheWrite: 0 },
    usd: 0.01,
    stop: 'tool_use',
  }))
  return {
    v: 1,
    kind: 'turn',
    src: (r.src ?? 'live') as 'live',
    machineId: 'm1',
    sessionId: r.sessionId ?? 'old',
    runId: r.runId,
    turnId: `t-${r.runId}`,
    agentId: null,
    parentAgentId: null,
    agentType: null,
    background: null,
    model: OPUS,
    effort: 'high',
    start,
    end: start + ms,
    ms,
    agentMs: ms,
    modelMs: ms * 0.7,
    toolMs: ms * 0.3,
    waitMs: 0,
    sleepMs: 0,
    outcome: 'finished',
    tokens: { input: 40, output: 400, cacheRead: 4000, cacheWrite: 0 },
    usd: 0.5,
    steps,
    tools: r.tools ?? [],
    errors: { tools: 0, steps: 0 },
    task: { taskType: r.taskType ?? 'website-work', skill: null, command: null, project: r.project === undefined ? 'website' : r.project, job: null, promptChars: 100, origin: 'composer', runStart: start },
    cond: { contextStart: null, contextTurn: null, cache: null, hour: 12, weekday: 0, tzOffsetMin: 300, permissionMode: null, version: null, cwdName: 'vault' },
    ...(r.eta ? { eta: r.eta } : {}),
  }
}

/** Ten runs of 60 to 150 seconds: usual (median) 105 s, slow (p80) 132 s. */
const tenRuns = (src: 'live' | 'backfill' = 'live') => Array.from({ length: 10 }, (_, i) => row({ runId: `r${i}`, seconds: 60 + i * 10, src, start: T0 - DAY + i * 1000 }))

function live(over: Partial<LiveView> = {}): LiveView {
  return {
    runId: 'now',
    task: { taskType: 'website-work', skill: 'website-work', command: null, project: 'website', job: null, promptChars: 100, origin: 'composer', runStart: T0 },
    isWorking: true,
    isMainOpen: true,
    startedAt: T0,
    elapsedMs: 30_000,
    waitMs: 0,
    agentMs: 30_000,
    toolMs: 5000,
    cost: { usd: 0.1, priced: 1, unpriced: 0 },
    mainSteps: 0,
    shape: null,
    model: OPUS,
    effort: 'high',
    promptChars: 100,
    tasks: { done: 0, total: 0 },
    isWaitingOnYou: false,
    now: null,
    agents: [],
    who: [],
    recentTps: [],
    cache: null,
    ...over,
  }
}

describe('the shape of a run', () => {
  test('past runs carry the shape of their first two requests; a live run matches on it once it is known', () => {
    const reads = Array.from({ length: 12 }, (_, i) => row({ runId: `read${i}`, seconds: 60, start: T0 - DAY + i * 1000, tools: [{ at: 100, name: 'Read', ms: 50, dir: 'wiki' }] }))
    const edits = Array.from({ length: 12 }, (_, i) => row({ runId: `edit${i}`, seconds: 300, start: T0 - DAY + (20 + i) * 1000, tools: [{ at: 1100, name: 'Edit', ms: 50, dir: 'wiki' }, { at: 3500, name: 'Bash', ms: 50 }] }))
    const p = new Profile()
    p.load([...reads, ...edits], 'now')
    expect(p.history.filter(r => r.shape === 'read').length).toBe(12)
    expect(p.history.filter(r => r.shape === 'edit').length).toBe(12)
    // before the third request: the type-wide figure (the project and model match every run)
    const blind = estimateRun(p, live({ agentMs: 1000, shape: null }))
    expect(blind.level).toBe('type+project+model')
    expect(blind.query.shape).toBe(null)
    expect(blind.n).toBe(24)
    // with the shape known: its own group, and its own figure
    const edit = estimateRun(p, live({ agentMs: 1000, shape: 'edit' }))
    expect(edit).toMatchObject({ level: 'type+project+shape+model', n: 12 })
    expect(edit.submit?.usualMs).toBe(300_000)
    expect(estimateRun(p, live({ agentMs: 1000, shape: 'read' })).submit?.usualMs).toBe(60_000)
  })
})

describe('the profile', () => {
  test('backfilled and live rows become runs; a live row wins its run; a backfilled step has no speed and is skipped', () => {
    const p = new Profile()
    const rows = [...tenRuns('backfill'), row({ runId: 'r0', seconds: 61, src: 'live', tps: 80 })]
    p.load(rows, 'this-session')
    expect([p.rowsLoaded, p.backfillRows, p.history.length]).toEqual([11, 10, 10])
    expect(p.history.find(r => r.runId === 'r0')?.agentMs).toBe(61_000)
    expect(p.usualTps(OPUS)).toBe(80)
    expect(Math.abs(p.modelShare - 0.7)).toBeLessThan(1e-9)
  })

  test('run time counts a background subagent: the clock any loop worked, the same as the band; cost sums every row', () => {
    // a live main turn of 40 s hands work to a background agent of 900 s, and a notification turn of 20 s follows it
    const main = { ...row({ runId: 'x', seconds: 40 }), usd: 0.5 }
    const subagent = { ...row({ runId: 'x', seconds: 900, start: T0 - DAY + 30_000 }), turnId: 'sub', agentId: 'a1', agentType: 'worker-sonnet', background: true as const, usd: 0.25 }
    const notice = { ...row({ runId: 'x', seconds: 20, start: T0 - DAY + 930_000 }), turnId: 'n1', usd: 0.1 }
    const p = new Profile()
    p.load([main, subagent, notice], 'other')
    const x = p.history.find(r => r.runId === 'x')
    expect(x?.agentMs).toBe(950_000)
    expect(Math.abs((x?.usd ?? 0) - 0.85) < 1e-9).toBe(true)
  })

  test("this session's rows are its own runs, rebuilt as rows arrive", () => {
    const p = new Profile()
    p.load([...tenRuns(), row({ runId: 'mine1', seconds: 30, sessionId: 's1' })], 's1')
    expect([p.history.length, p.session.length]).toEqual([10, 1])
    p.addRow(row({ runId: 'mine2', seconds: 40, sessionId: 's1', start: T0 }))
    expect(p.session.map(r => r.runId)).toEqual(['mine1', 'mine2'])
    expect(p.lastRun(null)?.runId).toBe('mine2')
    expect(idleView(p, T0 + 60_000, null).today).toEqual({ runs: 1, ms: 40_000, cost: { usd: 0.5, priced: 1, unpriced: 0 } })
  })
})

describe('the estimate', () => {
  test('under five runs of the kind: learning (n of 5)', () => {
    const p = new Profile()
    p.load(tenRuns().slice(0, 3), 's1')
    const est = estimateRun(p, live())
    expect(est).toMatchObject({ state: 'learning', learning: { have: 3, need: 5 }, leftMs: null, submit: null })
    expect(storedEta(est, 0)).toMatchObject({ taskType: 'website-work', learning: { have: 3, need: 5 }, usualMs: null })
  })

  test('on track, past usual, past slow; the time left never goes negative', () => {
    const p = new Profile()
    p.load(tenRuns(), 's1')
    const early = estimateRun(p, live({ agentMs: 30_000 }))
    expect(early).toMatchObject({ state: 'on-track', level: 'type+project+model', n: 10, submit: { usualMs: 105_000, slowMs: 132_000 } })
    // the survivors' median: every past run was still going at 30 s, 75 s more is the usual
    expect(early.leftMs).toBe(75_000)
    expect(early.totalMs).toBe(105_000)
    const late = estimateRun(p, live({ agentMs: 120_000 }))
    expect(late.state).toBe('past-usual')
    expect(late.leftMs).toBe(20_000) // 130, 140 and 150 s were still going: 10, 20, 30 s more
    const over = estimateRun(p, live({ agentMs: 200_000 }))
    expect(over).toMatchObject({ state: 'past-slow', leftMs: null })
  })

  test('steps and the task list refine the time left; a slow day scales the model part', () => {
    const p = new Profile()
    p.load(tenRuns(), 's1')
    const halfway = estimateRun(p, live({ agentMs: 30_000, mainSteps: 2, tasks: { done: 2, total: 4 } }))
    // history 75 s (weight 1), tasks 30 s (1.5), steps 30 s (0.5): (75 + 45 + 15) / 3
    expect(halfway.leftMs).toBe(45_000)
    const slow = estimateRun(p, live({ agentMs: 30_000, recentTps: [50, 50, 50] }))
    // usual 100 tok/s over today's 50: 2x on the model's 70% share, so 1.7x in all
    expect(slow.speed).toEqual({ tps: 50, usualTps: 100, etaPct: 70 })
    expect(Math.abs((slow.leftMs ?? 0) - 75_000 * 1.7)).toBeLessThan(1e-6)
  })

  test('the self-score is replayed from the history: it widens the slow figure when past estimates would have been too tight', () => {
    // runs one after another, each slower than all before it: every replayed slow figure comes in too low
    const spaced = Array.from({ length: 12 }, (_, i) => row({ runId: `r${i}`, seconds: 60 + i * 20, start: T0 - 3 * DAY + i * 3_600_000 }))
    const p = new Profile()
    p.load(spaced, 's1')
    const score = p.score()['website-work']
    expect(score?.n).toBe(7) // the first five runs had nothing to learn from
    expect(score?.coverage).toBeLessThan(0.8)
    const est = estimateRun(p, live())
    expect(est.factor).toBeGreaterThan(1)
    expect(est.coverage).toBe(score?.coverage)
    const plain = estimateAtSubmitOf(p)
    expect(Math.abs((est.submit?.slowMs ?? 0) - plain.slowMs * est.factor) < 1e-6).toBe(true)
  })

  test('the estimate a live run showed is scored apart and never feeds the correction', () => {
    const spaced = (eta?: TurnRow['eta']) => Array.from({ length: 12 }, (_, i) => row({ runId: `r${i}`, seconds: 60 + i * 20, start: T0 - 3 * DAY + i * 3_600_000, ...(eta ? { eta } : {}) }))
    const tight = { taskType: 'website-work', project: 'website', model: OPUS, level: 'type+project+model', n: 10, learning: null, usualMs: 50_000, slowMs: 60_000, usualUsd: null, slowUsd: null, factor: 1, steps: 0 }
    const without = new Profile()
    without.load(spaced(), 's1')
    const withShown = new Profile()
    withShown.load(spaced(tight), 's1')
    const a = without.score()['website-work']
    const b = withShown.score()['website-work']
    expect(b?.factor).toBe(a?.factor)
    expect(b?.coverage).toBe(a?.coverage)
    expect(a?.shown).toEqual({ n: 0, coverage: null })
    // twelve runs of 60 to 280 s against a shown slow figure of 60 s: only the first came in under it
    expect(b?.shown.n).toBe(12)
    expect(Math.abs((b?.shown.coverage ?? 0) - 1 / 12) < 1e-9).toBe(true)
  })
})

/** The uncorrected estimate at submit for the live() query. */
function estimateAtSubmitOf(p: Profile): { slowMs: number } {
  const match = p.match({ taskType: 'website-work', project: 'website', model: OPUS, effort: 'high', promptChars: 100 }, 'now')
  const ms = match.runs.map(r => r.agentMs).sort((x, y) => x - y)
  const pos = 0.8 * (ms.length - 1)
  const lo = Math.floor(pos)
  return { slowMs: (ms[lo] ?? 0) + ((ms[Math.ceil(pos)] ?? 0) - (ms[lo] ?? 0)) * (pos - lo) }
}
