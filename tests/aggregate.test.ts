import { describe, expect, test } from 'claude-code/testing'


import { agentMsBefore, dedupeRuns, earlyByRun, earlyFacts, groupByRun } from '../lib/aggregate.mjs'

/** Equal to nine decimal places (the kit has no toBeCloseTo). */
const near = (a: number | null | undefined, b: number) => typeof a === 'number' && Math.abs(a - b) < 1e-9

const T0 = Date.parse('2026-10-18T15:00:00Z')

type Row = Record<string, unknown> & { runId: string; start: number; end: number }

const row = (over: Partial<Row> & { runId: string; start: number; end: number }): Row => ({
  v: 1,
  kind: 'turn',
  src: 'live',
  sessionId: 's1',
  turnId: `t${over.start}`,
  agentId: null,
  model: 'claude-opus-5-5',
  effort: 'high',
  ms: over.end - over.start,
  usd: 0.1,
  tokens: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0 },
  steps: [{}, {}],
  tools: [],
  outcome: 'finished',
  task: { taskType: 'freeform', project: 'website', job: null, promptChars: 20, origin: 'composer' },
  ...over,
})

describe('runs from rows', () => {
  test('a live row wins over a backfilled row of the same run; a reloaded turn counts once', () => {
    const rows = [
      row({ runId: 'p1', start: T0, end: T0 + 1000, src: 'backfill' }),
      row({ runId: 'p1', start: T0, end: T0 + 1000 }),
      row({ runId: 'p1', start: T0, end: T0 + 1000 }),
      row({ runId: 'p2', start: T0 + 5000, end: T0 + 6000, src: 'backfill' }),
      { kind: 'session', runId: 'x', start: 0, end: 0 } as Row,
    ]
    const kept = dedupeRuns(rows as never)
    expect(kept.length).toBe(2)
    expect(kept.map(r => [r.runId, r.src])).toEqual([
      ['p1', 'live'],
      ['p2', 'backfill'],
    ])
  })

  test('parallel subagents count once; waits on the person and sleep are not agent time', () => {
    const rows = [
      // main turn 0..60s, with a 10s permission prompt at 5s and a 20s sleep from 30s
      row({
        runId: 'p1',
        start: T0,
        end: T0 + 60_000,
        tools: [{ at: 5000, waitMs: 10_000 }],
        sleeps: [[30_000, 20_000]],
        task: { taskType: 'website-work', project: 'website', job: 'relaunch', promptChars: 120, origin: 'composer' },
      }),
      // two subagents inside the main turn, overlapping each other
      row({ runId: 'p1', agentId: 'a1', agentType: 'Explore', model: 'claude-haiku-5-5', start: T0 + 1000, end: T0 + 20_000, usd: 0.01 }),
      row({ runId: 'p1', agentId: 'a2', agentType: 'Explore', model: 'claude-haiku-5-5', start: T0 + 2000, end: T0 + 25_000, usd: 0.02 }),
      // a background agent that ran on past the main turn
      row({ runId: 'p1', agentId: 'a3', agentType: 'general-purpose', background: true, start: T0 + 50_000, end: T0 + 90_000, usd: null, unpriced: true }),
    ]
    const [r] = groupByRun(rows as never)
    expect(r).toBeDefined()
    if (!r) return
    expect(r.taskType).toBe('website-work')
    expect(r.job).toBe('relaunch')
    expect(r.wallMs).toBe(90_000)
    expect(r.sleepMs).toBe(20_000)
    expect(r.waitMs).toBe(10_000)
    expect(r.agentMs).toBe(60_000)
    expect(r.turns).toBe(4)
    expect(r.subagents.map(a => a.agentType)).toEqual(['Explore', 'Explore', 'general-purpose'])
    expect(near(r.usd, 0.13)).toBe(true)
    expect(r.unpricedTurns).toBe(1)
    expect(r.mainSteps).toBe(2)
    expect(r.steps).toBe(8)
    expect(r.mainEndedAt).toBe(T0 + 60_000)
  })

  test('a prompt within two minutes in the same project marks the run as followed up', () => {
    const rows = [
      row({ runId: 'p1', start: T0, end: T0 + 10_000 }),
      row({ runId: 'p2', start: T0 + 70_000, end: T0 + 80_000 }),
      row({ runId: 'p3', start: T0 + 900_000, end: T0 + 910_000 }),
      row({ runId: 'p4', start: T0 + 920_000, end: T0 + 930_000, task: { taskType: 'freeform', project: 'acme' } }),
    ]
    const runs = groupByRun(rows as never)
    expect(runs.map(r => [r.runId, r.followedUp])).toEqual([
      ['p1', true],
      ['p2', false],
      ['p3', false],
      ['p4', false],
    ])
  })

  test('early facts: the request number of each skill and tool, across a run\'s main turns; the shape of the first two', () => {
    const step = (at: number) => ({ at, ms: 500, stop: 'tool_use' })
    const rows = [
      // turn one: requests at 0 s and 2 s; a Skill and a Read in the first, a Bash in the second
      row({
        runId: 'p1',
        start: T0,
        end: T0 + 10_000,
        steps: [step(0), step(2000)],
        tools: [
          { at: 500, name: 'Skill', skill: 'artifact-design', ms: 5 },
          { at: 900, name: 'Read', dir: 'wiki', ms: 5 },
          { at: 2600, name: 'Bash', cmd: 'ls', ms: 5, waitMs: 1000 },
        ],
      }),
      // a notification turn of the same run later: its request is the third, its Edit comes too late for the shape
      row({ runId: 'p1', start: T0 + 20_000, end: T0 + 30_000, steps: [step(0)], tools: [{ at: 600, name: 'Edit', dir: 'wiki', lines: [1, 1], ms: 5 }] }),
      // a subagent's tools are not the main loop's
      row({ runId: 'p1', agentId: 'a1', start: T0 + 1000, end: T0 + 5000, steps: [step(0)], tools: [{ at: 100, name: 'Agent', ms: 5 }] }),
    ]
    const facts = earlyFacts(rows.filter(r => !r.agentId) as never)
    expect(facts.steps).toBe(3)
    expect(facts.skills).toEqual(['artifact-design'])
    expect(facts.skillSteps).toEqual([1])
    expect(facts.calls.map(c => [c.name, c.step, c.dir ?? null])).toEqual([
      ['Skill', 1, null],
      ['Read', 1, 'wiki'],
      ['Bash', 2, null],
      ['Edit', 3, 'wiki'],
    ])
    // agent time gone when the third request began: 20 s on the clock less the 1 s hold
    expect(agentMsBefore(facts, 1)).toBe(0)
    expect(agentMsBefore(facts, 2)).toBe(2000)
    expect(agentMsBefore(facts, 3)).toBe(20_000 - 1000)
    expect(agentMsBefore(facts, 4)).toBe(null)
    const [r] = groupByRun(rows as never)
    expect(r?.shape).toBe('shell')
    expect(earlyByRun(rows as never).get('p1')?.facts.steps).toBe(3)
    // no tools in the first two requests: an answer
    expect(groupByRun([row({ runId: 'q', start: T0, end: T0 + 1000, steps: [step(0)] })] as never)[0]?.shape).toBe('answer')
  })
})
