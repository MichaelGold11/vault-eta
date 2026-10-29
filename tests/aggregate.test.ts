import { describe, expect, test } from 'claude-code/testing'


import { agentMsBefore, dedupeRuns, earlyByRun, earlyFacts, groupByRun, isPlaced, markFollowUps, runClock, summarizeRuns } from '../lib/aggregate.mjs'

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
    expect(r.mainLastAt).toBe(T0 + 60_000)
    // each agent's span on the clock, for the subagent-aware estimate
    expect(r.subagents.map(a => [a.startedAt - T0, a.endedAt - T0])).toEqual([
      [1000, 20_000],
      [2000, 25_000],
      [50_000, 90_000],
    ])
  })

  test('background agents in parallel count once on the clock, never summed; a gap where no loop worked is no one\'s', () => {
    const rows = [
      // the main turn hands work to three background agents and ends at 20 s
      row({ runId: 'p1', start: T0, end: T0 + 20_000, agentMs: 20_000 }),
      row({ runId: 'p1', agentId: 'a1', agentType: 'worker-sonnet', background: true, start: T0 + 5000, end: T0 + 300_000 }),
      row({ runId: 'p1', agentId: 'a2', agentType: 'worker-sonnet', background: true, start: T0 + 6000, end: T0 + 400_000 }),
      row({ runId: 'p1', agentId: 'a3', agentType: 'worker-haiku', background: true, start: T0 + 7000, end: T0 + 350_000 }),
      // the last one is back at 400 s; nothing works for 10 s; the notification turn runs 10 s
      row({ runId: 'p1', turnId: 'n1', start: T0 + 410_000, end: T0 + 420_000, agentMs: 10_000 }),
    ]
    const [r] = groupByRun(rows as never)
    // 0 to 400 s and 410 to 420 s: 410 s, where the agents summed would make 1,032 s and the main loop alone 30 s
    expect(r?.agentMs).toBe(410_000)
    expect(r?.mainMs).toBe(30_000)
    expect(r?.fellBack).toBe(0)
    expect(r?.wallMs).toBe(420_000)
    expect(summarizeRuns(rows as never)[0]?.agentMs).toBe(410_000)
    // a wait on the person in an agent's turn stops the clock there too; a sleep while the agents ran is not run time either
    const held = rows.map(x => (x.agentId === 'a2' ? { ...x, tools: [{ at: 100_000, name: 'Bash', waitMs: 30_000 }], sleeps: [[200_000, 50_000]] } : x))
    const [h] = groupByRun(held as never)
    expect([h?.agentMs, h?.waitMs, h?.sleepMs]).toEqual([410_000 - 30_000 - 50_000, 30_000, 50_000])
  })

  test('a backfilled row is placed by its timestamps: a stretch of over ten minutes with nothing in flight is a join between turns, not work', () => {
    const s = (at: number, ms: number) => ({ at, ms })
    // one backfilled main row for a turn of 50 s (a request, a call, a request) and the notification turn at 920 s: its
    // stored 60 s are the engine's turn times; its window spans the 870 s the agent worked, when the main loop did nothing
    const main = row({ runId: 'b1', src: 'backfill', start: T0, end: T0 + 930_000, ms: 60_000, agentMs: 60_000, steps: [s(0, 10_000), s(40_000, 10_000), s(920_000, 10_000)], tools: [{ at: 10_000, name: 'Agent', ms: 30_000 }] })
    // the agent ran 30 s to 900 s; resumed later with a message, its row runs on to 3,000 s and its first request back counts the gap
    const agent = row({ runId: 'b1', src: 'backfill', agentId: 'a1', background: true, start: T0 + 30_000, end: T0 + 3_000_000, steps: [s(0, 400_000), s(400_000, 470_000), s(2_870_000, 2_970_000)], tools: [] })
    expect([isPlaced(main as never), isPlaced(agent as never)]).toEqual([true, true])
    const [b] = groupByRun([main, agent] as never)
    // 0 to 900 s and 920 to 930 s, then the agent's 100 s back from 2,900 s: 1,010 s
    expect([b?.agentMs, b?.mainMs, b?.fellBack]).toEqual([1_010_000, 60_000, 0])
    // a gap of ten minutes or less is kept: a slow first token, a turn's own pause
    const short = row({ runId: 'b2', src: 'backfill', start: T0, end: T0 + 700_000, ms: 700_000, agentMs: 700_000, steps: [s(0, 50_000), s(650_000, 50_000)], tools: [] })
    expect(groupByRun([short] as never)[0]?.agentMs).toBe(700_000)
  })

  test('a live row that cannot be placed on the clock adds its own stored time, and is counted', () => {
    // from before the recorder kept a turn's own start: the engine's 10 s leave out a 98 s permission prompt that began before the window
    const cut = row({ runId: 'l1', start: T0, end: T0 + 10_000, agentMs: 8000, tools: [{ at: 0, name: 'Bash', ms: 100_000, runMs: 2000, waitMs: 98_000, asked: true }] })
    expect(isPlaced(cut as never)).toBe(false)
    const agent = row({ runId: 'l1', agentId: 'a1', background: true, start: T0 + 5000, end: T0 + 65_000 })
    expect([groupByRun([cut] as never)[0]?.agentMs, groupByRun([cut, agent] as never)[0]?.agentMs, groupByRun([cut, agent] as never)[0]?.fellBack]).toEqual([8000, 68_000, 1])
    // the same turn as the recorder writes it now, from its loop's start: the wait inside the window, the time given back
    const whole = row({ runId: 'l2', start: T0 - 108_000, end: T0 + 10_000, ms: 10_000, agentMs: 20_000, tools: [{ at: 10_000, name: 'Bash', ms: 100_000, runMs: 2000, waitMs: 98_000, asked: true }] })
    expect(isPlaced(whole as never)).toBe(true)
    expect(groupByRun([whole] as never)[0]?.agentMs).toBe(20_000)
  })

  test("an agent's span runs from its first turn to its last; the main loop's last activity counts a request past its row's end", () => {
    const rows = [
      // a backfilled main row whose end stops short of a request a notification brought at 70 s
      row({ runId: 'p1', start: T0, end: T0 + 30_000, steps: [{ at: 0, ms: 1000 }, { at: 70_000, ms: 4000 }] }),
      row({ runId: 'p1', agentId: 'a1', agentType: 'worker-sonnet', start: T0 + 5000, end: T0 + 20_000 }),
      row({ runId: 'p1', agentId: 'a1', agentType: 'worker-sonnet', start: T0 + 40_000, end: T0 + 65_000 }),
    ]
    const [r] = groupByRun(rows as never)
    expect(r?.mainEndedAt).toBe(T0 + 30_000)
    expect(r?.mainLastAt).toBe(T0 + 74_000)
    expect(r?.subagents.map(a => [a.agentType, a.startedAt - T0, a.endedAt - T0])).toEqual([['worker-sonnet', 5000, 65_000]])
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
    // run time gone when the third request began: the first turn's 10 s less the 1 s hold; the 10 s gap before the notification is no one's
    expect(agentMsBefore(facts, 1)).toBe(0)
    expect(agentMsBefore(facts, 2)).toBe(2000)
    expect(agentMsBefore(facts, 3)).toBe(10_000 - 1000)
    expect(agentMsBefore(facts, 4)).toBe(null)
    // a background agent that worked through the gap fills it: from the run's rows, the clock counts its 15 s past the first turn
    const withAgent = [...rows, row({ runId: 'p1', agentId: 'bg', background: true, start: T0 + 8000, end: T0 + 25_000 })]
    expect(agentMsBefore(earlyFacts(withAgent as never), 3)).toBe(20_000 - 1000)
    expect(agentMsBefore(earlyByRun(withAgent as never).get('p1')?.facts as never, 3)).toBe(20_000 - 1000)
    // no leakage: how long that agent goes on after the request began changes nothing at it
    const longer = [...rows, row({ runId: 'p1', agentId: 'bg', background: true, start: T0 + 8000, end: T0 + 2_000_000 })]
    expect(agentMsBefore(earlyFacts(longer as never), 3)).toBe(20_000 - 1000)
    const [r] = groupByRun(rows as never)
    expect(r?.shape).toBe('shell')
    expect(earlyByRun(rows as never).get('p1')?.facts.steps).toBe(3)
    // no tools in the first two requests: an answer
    expect(groupByRun([row({ runId: 'q', start: T0, end: T0 + 1000, steps: [step(0)] })] as never)[0]?.shape).toBe('answer')
  })

  test('the labels known at submit: the kept estimate\'s, else what the first two requests showed, never more than the run\'s own', () => {
    const step = (at: number) => ({ at, ms: 500, stop: 'tool_use' })
    const steps = [step(0), step(2000), step(4000), step(6000)]
    const task = (taskType: string, project: string | null, command: string | null = null) => ({ taskType, skill: command ? null : taskType === 'freeform' ? null : taskType, command, project, job: null, promptChars: 20, origin: 'composer' })
    const one = (runId: string, over: Partial<Row>) => row({ runId, start: T0, end: T0 + 10_000, steps, src: 'backfill', ...over })
    const at = (rows: Row[]) => {
      const [r] = summarizeRuns(rows as never)
      return { own: [r?.taskType, r?.project], submit: [r?.submitTaskType, r?.submitProject] }
    }
    // a live run's kept estimate says what it knew, whatever the run went on to do
    const eta = { taskType: 'freeform', project: null, model: 'claude-opus-5-5', level: 'type+model', n: 9, learning: null, usualMs: 1000, slowMs: 2000, usualUsd: null, slowUsd: null, factor: 1, steps: 2 }
    expect(at([one('live', { src: 'live', eta, task: task('wrap', 'website'), tools: [{ at: 4500, name: 'Skill', skill: 'wrap', ms: 5 }] })])).toEqual({ own: ['wrap', 'website'], submit: ['freeform', null] })
    // a backfilled run: a skill loaded in the first request and a folder edited in the second were known
    const early = [
      { at: 500, name: 'Skill', skill: 'website-work', ms: 5 },
      { at: 2500, name: 'Edit', dir: '01-projects/website/plan', ms: 5 },
    ]
    expect(at([one('b1', { task: task('website-work', 'website'), tools: early })])).toEqual({ own: ['website-work', 'website'], submit: ['website-work', 'website'] })
    // the same skill loaded in the third request and the folder edited in the fourth were not
    const late = [
      { at: 4500, name: 'Skill', skill: 'wrap', ms: 5 },
      { at: 6500, name: 'Edit', dir: '01-projects/website/plan', ms: 5 },
    ]
    expect(at([one('b2', { task: task('wrap', 'website'), tools: late })])).toEqual({ own: ['wrap', 'website'], submit: ['freeform', null] })
    // a slash command is known at submit, and a project skill's name gives its project
    expect(at([one('b3', { task: task('website-work', 'website', 'website-work'), tools: [] })])).toEqual({ own: ['website-work', 'website'], submit: ['website-work', 'website'] })
    expect(at([one('b4', { task: task('wrap', 'website', 'wrap'), tools: late })])).toEqual({ own: ['wrap', 'website'], submit: ['wrap', null] })
    // a label the rows do not explain (no Skill call or command names it) was not known at submit
    expect(at([one('b5', { task: task('wrap', 'website'), tools: [] })])).toEqual({ own: ['wrap', 'website'], submit: ['freeform', null] })
    // an early skill the run's own labelling skipped (an ignored one, a router) does not name it at submit either
    const ignored = [{ at: 500, name: 'Skill', skill: 'kickoff', ms: 5 }, ...late]
    expect(at([one('b6', { task: task('wrap', 'website'), tools: ignored })])).toEqual({ own: ['wrap', 'website'], submit: ['freeform', null] })
    // an early folder in another project than the run's own: not taken for either
    const elsewhere = [{ at: 500, name: 'Edit', dir: '01-projects/acme', ms: 5 }]
    expect(at([one('b7', { task: task('freeform', 'website'), tools: elsewhere })])).toEqual({ own: ['freeform', 'website'], submit: ['freeform', null] })
  })
})

describe('runClock', () => {
  test('parallel loops count once; the main loop is its own part', () => {
    // main 0 to 10 s, a subagent 5 to 25 s: 25 s on the clock, 10 s of it the main loop's
    const c = runClock([
      row({ runId: 'c1', start: T0, end: T0 + 10_000, agentMs: 10_000 }),
      row({ runId: 'c1', agentId: 'a1', start: T0 + 5000, end: T0 + 25_000, agentMs: 20_000 }),
    ] as never)
    expect(c).toEqual({ agentMs: 25_000, mainMs: 10_000, waitMs: 0, sleepMs: 0, fellBack: 0 })
  })

  test('a gap where nothing worked is nobody\'s; a wait on the person is cut out and counted as a wait', () => {
    const gap = runClock([
      row({ runId: 'c2', start: T0, end: T0 + 10_000, agentMs: 10_000 }),
      row({ runId: 'c2', turnId: 'n', start: T0 + 60_000, end: T0 + 70_000, agentMs: 10_000 }),
    ] as never)
    expect(gap.agentMs).toBe(20_000)
    const waited = runClock([row({ runId: 'c3', start: T0, end: T0 + 100_000, agentMs: 70_000, waitMs: 30_000, tools: [{ at: 10_000, name: 'Bash', ms: 30_000, waitMs: 30_000 }] })] as never)
    expect(waited.agentMs).toBe(70_000)
    expect(waited.waitMs).toBe(30_000)
  })

  test('a backfilled row loses its idle stretch over ten minutes; a row that cannot be placed adds its stored time and is counted', () => {
    const steps = [{ at: 0, ms: 10_000 }, { at: 1_200_000, ms: 300_000 }]
    const imported = runClock([row({ runId: 'c4', src: 'backfill', start: T0, end: T0 + 1_500_000, agentMs: 1_500_000, steps } as never)] as never)
    expect(imported.agentMs).toBe(310_000)
    expect(imported.fellBack).toBe(0)
    // a live window of 10 s that stores 5 s with no wait to explain the difference
    const lost = runClock([row({ runId: 'c5', start: T0, end: T0 + 10_000, agentMs: 5000 })] as never)
    expect(lost.fellBack).toBe(1)
    expect(lost.agentMs).toBe(5000)
    expect(lost.mainMs).toBe(5000)
  })
})

describe('markFollowUps', () => {
  const run = (sessionId: string, startedAt: number, mainEndedAt: number, project: string | null = 'website') => ({ sessionId, startedAt, mainEndedAt, project, followedUp: false })

  test('a run whose next prompt in the same session and project came within two minutes is marked; the last run of a session never is', () => {
    const runs = [run('s1', 0, 60_000), run('s1', 150_000, 200_000), run('s1', 400_000, 450_000), run('s2', 100_000, 110_000)]
    markFollowUps(runs as never)
    // 150 s - 60 s = 90 s: followed up; 400 s - 200 s = 200 s: not; last of the session and a lone session: not
    expect(runs.map(r => r.followedUp)).toEqual([true, false, false, false])
  })

  test('exactly two minutes counts; another project does not; a next run that began before the last ended does not', () => {
    const edge = [run('s1', 0, 10_000), run('s1', 130_000, 140_000)]
    markFollowUps(edge as never)
    expect(edge[0]?.followedUp).toBe(true)
    const other = [run('s1', 0, 10_000, 'website'), run('s1', 20_000, 30_000, 'app')]
    markFollowUps(other as never)
    expect(other[0]?.followedUp).toBe(false)
    const overlap = [run('s1', 0, 50_000), run('s1', 20_000, 60_000)]
    markFollowUps(overlap as never)
    expect(overlap[0]?.followedUp).toBe(false)
  })

  test('summarizeRuns applies it, and clears a mark that no longer holds', () => {
    const rows = [row({ runId: 'f1', start: T0, end: T0 + 10_000 }), row({ runId: 'f2', start: T0 + 60_000, end: T0 + 70_000 })]
    const [a, b] = summarizeRuns(rows as never)
    expect([a?.followedUp, b?.followedUp]).toEqual([true, false])
    if (a) a.followedUp = true
    const later = [run('s1', 0, 10_000), run('s1', 900_000, 910_000)]
    later[0]!.followedUp = true
    markFollowUps(later as never)
    expect(later[0]?.followedUp).toBe(false)
  })
})
