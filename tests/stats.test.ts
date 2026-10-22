import { describe, expect, test } from 'claude-code/testing'


import {
  calibrate,
  combineRemaining,
  estimateAtSubmit,
  matchRuns,
  median,
  quantile,
  remainingAfter,
  remainingFromProgress,
  replay,
  replayAtStep,
  scoreByType,
  scoreRuns,
  speedFactor,
  stepFraction,
  taskFraction,
  typicalError,
  LEVELS,
  REPLAY_WINDOW,
} from '../lib/stats.mjs'

/** Equal to nine decimal places (the kit has no toBeCloseTo). */
const near = (a: number | null | undefined, b: number) => typeof a === 'number' && Math.abs(a - b) < 1e-9

type Past = { taskType: string; project: string | null; shape?: string | null; model: string | null; effort?: string | null; promptChars?: number; agentMs: number; usd: number | null; endedAt: number }

const run = (over: Partial<Past> & { agentMs: number }, i = 0): Past => ({
  taskType: 'wrap',
  project: null,
  model: 'claude-opus-5-5',
  effort: 'high',
  promptChars: 40,
  usd: 0.5,
  endedAt: 1000 + i,
  ...over,
})

describe('quantiles', () => {
  test('median and p80 by interpolation', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(quantile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.8)).toBe(82)
    expect(quantile([], 0.5)).toBe(null)
  })
})

describe('matching', () => {
  test('falls back from type+project+model to fewer keys while too few match', () => {
    const history = [
      ...Array.from({ length: 3 }, (_, i) => run({ agentMs: 100, project: 'website' }, i)),
      ...Array.from({ length: 4 }, (_, i) => run({ agentMs: 200, project: 'website', model: 'claude-sonnet-5-5' }, 10 + i)),
    ]
    const exact = matchRuns(history, { taskType: 'wrap', project: 'website', model: 'claude-opus-5-5' })
    expect(exact.level).toBe('type+project')
    expect(exact.runs.length).toBe(7)
    expect(matchRuns(history, { taskType: 'wrap', project: 'website', model: 'claude-sonnet-5-5' }, { minMatches: 4 }).level).toBe('type+project+model')
  })

  test('a key the query does not know yet is not matched: no project, no shape', () => {
    // twelve runs with no project, six in one project: a run with no project yet is not "a run that had none"
    const none = Array.from({ length: 12 }, (_, i) => run({ agentMs: 100, project: null }, i))
    const some = Array.from({ length: 6 }, (_, i) => run({ agentMs: 500, project: 'website' }, 20 + i))
    const m = matchRuns([...none, ...some], { taskType: 'wrap', project: null, model: 'claude-opus-5-5' })
    expect(m.level).toBe('type+model')
    expect(m.runs.length).toBe(18)
    // once the project is known it is matched
    expect(matchRuns([...none, ...some], { taskType: 'wrap', project: 'website', model: 'claude-opus-5-5' }).level).toBe('type+project+model')
  })

  test('shape levels come first when known and 10 runs hold; fewer fall back, and an unknown shape is skipped', () => {
    const reads = Array.from({ length: 10 }, (_, i) => run({ agentMs: 30, shape: 'read' }, i))
    const edits = Array.from({ length: 9 }, (_, i) => run({ agentMs: 300, shape: 'edit' }, 20 + i))
    const history = [...reads, ...edits]
    const read = matchRuns(history, { taskType: 'wrap', model: 'claude-opus-5-5', shape: 'read' })
    expect(read.level).toBe('type+shape+model')
    expect(read.runs.map(r => r.agentMs)).toEqual(Array(10).fill(30))
    // nine edit runs are under the shape levels' ten: the coarser group answers
    const edit = matchRuns(history, { taskType: 'wrap', model: 'claude-opus-5-5', shape: 'edit' })
    expect(edit.level).toBe('type+model')
    expect(edit.runs.length).toBe(19)
    // no shape yet (before the third request): the same coarser group
    expect(matchRuns(history, { taskType: 'wrap', model: 'claude-opus-5-5', shape: null }).level).toBe('type+model')
    expect(matchRuns(history, { taskType: 'wrap', model: 'claude-opus-5-5' }).level).toBe('type+model')
  })

  test('learning while under five of the task type', () => {
    const m = matchRuns([run({ agentMs: 1 }), run({ agentMs: 2 }), run({ agentMs: 3 })], { taskType: 'wrap' })
    expect(m.level).toBe(null)
    expect(m.learning).toEqual({ have: 3, need: 5 })
    const est = estimateAtSubmit(m)
    expect(est.usualMs).toBe(null)
    expect(est.learning).toEqual({ have: 3, need: 5 })
  })

  test('effort and prompt size break ties when they alone hold enough; the newest 50 count', () => {
    const history = [
      ...Array.from({ length: 6 }, (_, i) => run({ agentMs: 100, effort: 'low' }, i)),
      ...Array.from({ length: 6 }, (_, i) => run({ agentMs: 900, effort: 'high', promptChars: 5000 }, 100 + i)),
      ...Array.from({ length: 6 }, (_, i) => run({ agentMs: 500, effort: 'high', promptChars: 50 }, 200 + i)),
    ]
    const low = matchRuns(history, { taskType: 'wrap', effort: 'low' })
    expect(low.runs.every(r => r.effort === 'low')).toBe(true)
    const short = matchRuns(history, { taskType: 'wrap', effort: 'high', promptChars: 60 })
    expect(short.runs.map(r => r.agentMs)).toEqual(Array(6).fill(500))
    const many = Array.from({ length: 80 }, (_, i) => run({ agentMs: i }, i))
    const newest = matchRuns(many, { taskType: 'wrap' })
    expect(newest.runs.length).toBe(50)
    expect(newest.runs[0]?.agentMs).toBe(79)
  })

  test('the estimate at submit: usual, slow, and the self-score correction', () => {
    const runs = Array.from({ length: 10 }, (_, i) => run({ agentMs: (i + 1) * 60_000, usd: (i + 1) / 10 }, i))
    const m = matchRuns(runs, { taskType: 'wrap' })
    const est = estimateAtSubmit(m)
    expect(est.n).toBe(10)
    expect(est.usualMs).toBe(330_000)
    expect(est.slowMs).toBe(492_000)
    expect(near(est.usualUsd, 0.55)).toBe(true)
    expect(estimateAtSubmit(m, { slowFactor: 1.5 }).slowMs).toBe(738_000)
  })
})

describe('re-estimating while it runs', () => {
  const runs = [60, 120, 180, 240, 300, 600].map((s, i) => run({ agentMs: s * 1000 }, i))

  test('of past runs still going at this point, how much longer they took', () => {
    const at100 = remainingAfter(runs, 100_000)
    expect(at100.n).toBe(5)
    expect(at100.usualMs).toBe(140_000)
    const late = remainingAfter(runs, 400_000)
    expect(late.usualMs).toBe(null)
    expect(late.isPastSlow).toBe(true)
  })

  test('progress from steps and a task list', () => {
    expect(remainingFromProgress(60_000, 0.25)).toBe(180_000)
    expect(remainingFromProgress(60_000, 1)).toBe(null)
    expect(stepFraction(30, 20)).toBe(0.95)
    expect(stepFraction(5, 20)).toBe(0.25)
    expect(stepFraction(5, null)).toBe(null)
    expect(taskFraction(1, 1)).toBe(null)
    expect(taskFraction(2, 4)).toBe(0.5)
  })

  test('today\'s speed scales the model part of the estimate', () => {
    expect(speedFactor([40, 50, 60], 100)).toBe(2)
    expect(speedFactor([], 100)).toBe(1)
    expect(speedFactor([1000], 100)).toBe(0.5)
    const plain = combineRemaining({ elapsedMs: 60_000, survivors: { usualMs: 120_000, slowMs: 180_000 } })
    expect(plain).toEqual({ usualMs: 120_000, slowMs: 180_000, sources: ['history'] })
    const slowDay = combineRemaining({ elapsedMs: 60_000, survivors: { usualMs: 120_000, slowMs: 180_000 }, speed: 2, modelShare: 0.5 })
    expect(slowDay.usualMs).toBe(180_000)
    const withTasks = combineRemaining({ elapsedMs: 60_000, survivors: { usualMs: 120_000, slowMs: 180_000 }, taskFraction: 0.5 })
    expect(withTasks.usualMs).toBe((120_000 * 1 + 60_000 * 1.5) / 2.5)
    expect(withTasks.sources).toEqual(['history', 'tasks'])
    expect(combineRemaining({ elapsedMs: 1, survivors: { usualMs: null, slowMs: null } }).usualMs).toBe(null)
  })
})

describe('scoring itself', () => {
  test('coverage of the slow figure and the factor that would reach 80%', () => {
    const scored = [0.5, 0.6, 0.7, 0.8, 0.9, 1.2, 1.5, 2].map(r => ({ slowMs: 100, actualMs: 100 * r }))
    const cal = calibrate(scored)
    expect(cal.n).toBe(8)
    expect(cal.coverage).toBe(5 / 8)
    expect(near(cal.factor, 1.38)).toBe(true)
    expect(calibrate(scored.slice(0, 3)).factor).toBe(1)
    expect(calibrate([]).coverage).toBe(null)
  })

  test('per task type: which estimate missed by less', () => {
    expect(near(typicalError([{ usualMs: 100, actualMs: 200 }]), Math.log(2))).toBe(true)
    const records = Array.from({ length: 6 }, () => ({
      taskType: 'wrap',
      actualMs: 200,
      submit: { usualMs: 100, slowMs: 150 },
      step: { usualMs: 190, slowMs: 260 },
    }))
    const scores = scoreByType(records)
    expect(scores.wrap?.best).toBe('step')
    expect(scores.wrap?.coverage).toBe(0)
    expect(near(scores.wrap?.factor, 200 / 150)).toBe(true)
  })
})

type Timed = Past & { runId: string; startedAt: number }

/** A run that starts at `at` and takes `seconds`. */
const timed = (runId: string, at: number, seconds: number, over: Partial<Past> = {}): Timed => ({
  ...run({ agentMs: seconds * 1000, endedAt: at + seconds * 1000, ...over }),
  runId,
  startedAt: at,
})

describe('replaying the history', () => {
  test('a run is estimated only from runs that ended before it started', () => {
    // seven 100 s runs, one an hour apart: the sixth is the first with five behind it
    const seq = Array.from({ length: 7 }, (_, i) => timed(`s${i}`, i * 3_600_000, 100))
    // overlapping the sixth: it started before the sixth did and ended long after, so it must never be matched
    const poison = timed('poison', 5 * 3_600_000 - 1000, 99_999)
    const records = replay([...seq, poison])
    const byId = new Map(records.map(r => [r.runId, r]))
    expect(byId.get('s4')).toMatchObject({ n: 4, submit: null })
    // s5 starts as the poison run is already going, so it does not see it either
    expect(byId.get('s5')).toMatchObject({ n: 5, submit: { usualMs: 100_000, slowMs: 100_000 } })
    // the poison run ends long after s6 starts: s6 sees s0 to s5 and not it (usual and slow stay 100 s)
    expect(byId.get('s6')).toMatchObject({ n: 6, submit: { usualMs: 100_000, slowMs: 100_000 } })
    // the poison run itself started with s0 to s4 behind it
    expect(byId.get('poison')).toMatchObject({ n: 5, actualMs: 99_999_000 })
    // the records come in start order
    expect(records.map(r => r.runId)).toEqual(['s0', 's1', 's2', 's3', 's4', 'poison', 's5', 's6'])
  })

  test('the same matching as live: the fallback levels, the limit and the minimum', () => {
    // six runs of one project then one of another: the other project falls back to the type level
    const same = Array.from({ length: 6 }, (_, i) => timed(`a${i}`, i * 3_600_000, 60, { project: 'website' }))
    const other = timed('b', 7 * 3_600_000, 90, { project: 'acme' })
    const rec = replay([...same, other]).find(r => r.runId === 'b')
    expect(rec?.level).toBe('type+model')
    expect(rec?.n).toBe(6)
    // a limit of 3 keeps the newest three
    const limited = replay([...same, other], { limit: 3 }).find(r => r.runId === 'b')
    expect(limited?.n).toBe(3)
    // a different task type never matches
    const apart = replay([...same, timed('c', 7 * 3_600_000, 90, { taskType: 'ship' })]).find(r => r.runId === 'c')
    expect(apart).toMatchObject({ n: 0, submit: null })
  })

  test('the correction is fitted to uncorrected estimates, never to what a live run showed', () => {
    // twelve runs, each longer than those before: the replayed slow figure keeps coming in too low
    const seq = Array.from({ length: 12 }, (_, i) => timed(`r${i}`, i * 3_600_000, 60 + i * 20))
    const plain = scoreRuns(seq).wrap
    expect(plain?.n).toBe(7)
    expect(plain?.factor).toBeGreaterThan(1)
    expect(plain?.shown).toEqual({ n: 0, coverage: null })
    // the same runs, each carrying a very generous estimate it "showed": the fitted correction does not move
    const shownLoose = seq.map(r => ({ ...r, eta: { usualMs: 1_000_000, slowMs: 2_000_000 } }))
    const withShown = scoreRuns(shownLoose).wrap
    expect(withShown?.factor).toBe(plain?.factor)
    expect(withShown?.coverage).toBe(plain?.coverage)
    expect(withShown?.shown).toEqual({ n: 12, coverage: 1 })
    // replay itself is uncorrected: slow is the plain 80th percentile of the matches
    const fifth = replay(seq).find(r => r.runId === 'r5')
    expect(fifth?.submit?.slowMs).toBe(quantile([60, 80, 100, 120, 140].map(x => x * 1000), 0.8))
  })

  test('the step estimate is compared with the submit estimate on the same runs', () => {
    const seq = Array.from({ length: 12 }, (_, i) => ({ ...timed(`r${i}`, i * 3_600_000, 100), etaMid: i >= 6 ? { atMs: 50_000, usualMs: 100_000, slowMs: 110_000 } : null }))
    // submit is exact too (all runs equal), so a tie goes to submit
    expect(scoreRuns(seq).wrap?.best).toBe('submit')
    const off = seq.map((r, i) => (i < 6 ? r : { ...r, etaMid: { atMs: 50_000, usualMs: 50_000, slowMs: 60_000 } }))
    expect(scoreRuns(off).wrap?.best).toBe('submit')
    // runs that keep growing leave the submit estimate behind; a step estimate that tracks them wins
    const growing = Array.from({ length: 12 }, (_, i) => ({ ...timed(`g${i}`, i * 3_600_000, 60 + i * 20), etaMid: { atMs: 1, usualMs: (60 + i * 20) * 1000, slowMs: (70 + i * 20) * 1000 } }))
    expect(scoreRuns(growing).wrap?.best).toBe('step')
  })

  test('the replay never sees a run\'s shape: it is not known at submit', () => {
    // fast read runs and slow edit runs of one type: with the shape hidden both get the type-wide figure
    const runs = Array.from({ length: 24 }, (_, i) => ({ ...timed(`s${i}`, i * 3_600_000, i % 2 === 0 ? 20 : 200), shape: i % 2 === 0 ? 'read' : 'edit' }))
    const rec = replay(runs).find(r => r.runId === 's23')
    expect(rec?.level).toBe('type+model')
    expect(rec?.n).toBe(23)
    // a replay given the shape (as known after the second request) uses it
    const known = replay(runs, { queryOf: r => ({ ...r }) }).find(r => r.runId === 's23')
    expect(known?.level).toBe('type+shape+model')
    expect(known?.submit?.usualMs).toBe(200_000)
  })

  test('the step replay: matches still going give the time left; the shape is used once known', () => {
    const runs = Array.from({ length: 24 }, (_, i) => ({ ...timed(`s${i}`, i * 3_600_000, i % 2 === 0 ? 20 : 200), shape: i % 2 === 0 ? 'read' : 'edit' }))
    // 30 s into a run: only the 200 s runs are still going, whatever the shape says
    const atStep = (shape: string | undefined) =>
      replayAtStep(runs, { stateOf: r => (r.runId === 's23' ? { elapsedMs: 30_000, query: { taskType: 'wrap', model: r.model, shape } } : null) })
    const [blind] = atStep(undefined)
    expect(blind).toMatchObject({ runId: 's23', level: 'type+model', n: 23 })
    expect(blind?.step?.usualMs).toBe(200_000)
    // an edit-shaped run: the edit matches' 200 s; a read-shaped one would still be matched to the read runs' 20 s
    // but they are done by 30 s, so the figure falls back to none still going and then to nothing ahead
    const [edit] = atStep('edit')
    expect(edit).toMatchObject({ level: 'type+shape+model', n: 11 })
    expect(edit?.step?.usualMs).toBe(200_000)
    const [read] = atStep('read')
    expect(read?.level).toBe('type+shape+model')
    expect(read?.step).toBe(null)
    // a run that ended before the state, or has no state, is not scored
    expect(replayAtStep(runs, { stateOf: () => ({ elapsedMs: 500_000, query: { taskType: 'wrap' } }) })).toEqual([])
    expect(replayAtStep(runs, { stateOf: () => null })).toEqual([])
  })

  test('1,500 runs replay well under 300 ms', () => {
    const types = ['wrap', 'ship', 'design', 'memory', 'freeform']
    const runs = Array.from({ length: 1500 }, (_, i) => {
      const seconds = 30 + ((i * 37) % 400)
      return timed(`r${i}`, i * 600_000, seconds, { taskType: types[i % types.length] ?? 'wrap', project: i % 3 === 0 ? 'website' : null })
    })
    const t0 = Date.now()
    const records = replay(runs)
    const ms = Date.now() - t0
    expect(records.length).toBe(1500)
    expect(records.filter(r => r.submit).length).toBeGreaterThan(1400)
    expect(ms).toBeLessThan(300)
    const t1 = Date.now()
    scoreRuns(runs)
    expect(Date.now() - t1).toBeLessThan(300)
  })
})

/** matchRuns as it was before the one-pass rewrite: the reference the fast one must agree with. */
function referenceMatch(history: Past[], query: Record<string, any>, options: { minMatches?: number; limit?: number } = {}) {
  const minMatches = options.minMatches ?? 5
  const limit = options.limit ?? 50
  const optional = new Set(['project', 'shape'])
  const usable = history.filter(r => Number.isFinite(r.agentMs) && r.agentMs >= 0)
  const newest = (runs: Past[]) => [...runs].sort((a, b) => b.endedAt - a.endedAt).slice(0, limit)
  for (const level of LEVELS) {
    if (!level.keys.every(k => !optional.has(k) || query[k] != null)) continue
    let pool = usable.filter(r => level.keys.every(k => ((r as any)[k] ?? null) === (query[k] ?? null)))
    if (pool.length < Math.max(level.min ?? 0, minMatches)) continue
    if (query.effort !== undefined && query.effort !== null) {
      const same = pool.filter(r => r.effort === query.effort)
      if (same.length >= minMatches) pool = same
    }
    const chars = query.promptChars ?? 0
    if (chars > 0) {
      const similar = pool.filter(r => (r.promptChars ?? 0) > 0 && Math.abs(Math.log((r.promptChars ?? 1) / chars)) <= Math.log(4))
      if (similar.length >= minMatches) pool = similar
    }
    return { level: level.name, runs: newest(pool), learning: null }
  }
  const sameType = usable.filter(r => r.taskType === query.taskType)
  return { level: null, runs: newest(sameType), learning: { have: sameType.length, need: minMatches } }
}

describe('the one-pass matcher', () => {
  test('agrees with the reference on random histories, sorted or not, ties included', () => {
    let seed = 7
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    const pick = <T,>(list: T[]): T => list[Math.floor(rnd() * list.length)] as T
    for (let trial = 0; trial < 300; trial++) {
      const n = Math.floor(rnd() * 160)
      const history: Past[] = Array.from({ length: n }, (_, i) => ({
        taskType: pick(['wrap', 'ship', 'freeform']),
        project: pick([null, 'web', 'app']),
        shape: pick([null, 'read', 'edit']),
        model: pick(['claude-opus-5-5', 'claude-sonnet-5-5', null]),
        effort: pick([null, 'high', 'low']),
        promptChars: pick([0, 20, 40, 100, 160, 900]),
        agentMs: pick([1000, 5000, 20_000, 60_000, Number.NaN, -1]),
        usd: 0.1,
        // coarse ends, so runs often end together
        endedAt: Math.floor(rnd() * 40) * 1000,
      }))
      const query = { taskType: pick(['wrap', 'ship', 'freeform']), project: pick([null, 'web']), shape: pick([null, undefined, 'edit']), model: pick(['claude-opus-5-5', null]), effort: pick([null, 'high']), promptChars: pick([0, 40, 300]) }
      const options = { minMatches: pick([3, 5]), limit: pick([4, 10, 50]) }
      const want = referenceMatch(history, query, options)
      const ids = (m: { runs: readonly unknown[] }) => m.runs.map(r => history.indexOf(r as Past))
      const got = matchRuns(history as never, query as never, options)
      expect({ level: got.level, learning: got.learning, runs: ids(got) }).toEqual({ level: want.level, learning: want.learning, runs: ids(want) })
      const asc = [...history].sort((a, b) => a.endedAt - b.endedAt)
      const sorted = matchRuns(asc as never, query as never, { ...options, sortedAsc: true })
      expect({ level: sorted.level, runs: sorted.runs.map(r => history.indexOf(r as never)) }).toEqual({ level: want.level, runs: ids(want) })
    }
  })

  test('the replay looks back over the last REPLAY_WINDOW runs of the type, and a year of runs scores fast', () => {
    expect(REPLAY_WINDOW).toBe(500)
    // 40 old runs of a project, then 600 of another: the old project is out of reach
    const runs = [
      ...Array.from({ length: 40 }, (_, i) => ({ runId: `old${i}`, taskType: 'wrap', project: 'old', model: 'm', agentMs: 1000, usd: 0, startedAt: i * 10, endedAt: i * 10 + 5 })),
      ...Array.from({ length: 600 }, (_, i) => ({ runId: `new${i}`, taskType: 'wrap', project: 'new', model: 'm', agentMs: 9000, usd: 0, startedAt: 1000 + i * 10, endedAt: 1000 + i * 10 + 5 })),
      { runId: 'probe', taskType: 'wrap', project: 'old', model: 'm', agentMs: 1000, usd: 0, startedAt: 100_000, endedAt: 100_005 },
    ]
    const probe = (window?: number) => replay(runs as never, window === undefined ? {} : { window }).find(r => r.runId === 'probe')
    expect(probe()?.level).toBe('type+model')
    expect(probe()?.submit?.usualMs).toBe(9000)
    expect(probe(Infinity)?.level).toBe('type+project+model')
    expect(probe(Infinity)?.submit?.usualMs).toBe(1000)

    const year = Array.from({ length: 10_000 }, (_, i) => ({
      runId: `y${i}`,
      taskType: i % 9 === 0 ? 'wrap' : 'freeform',
      project: ['a', 'b', 'c', null][i % 4] ?? null,
      model: 'claude-opus-5-5',
      effort: null,
      promptChars: 50 + ((i * 7919) % 2000),
      agentMs: 20_000 + ((i * 104_729) % 400_000),
      usd: 0.1,
      startedAt: i * 3_000_000,
      endedAt: i * 3_000_000 + 400_000,
    }))
    const t0 = Date.now()
    scoreRuns(year as never)
    expect(Date.now() - t0).toBeLessThan(250)
  })
})
