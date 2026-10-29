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
  baselineVerdict,
  bootstrapWins,
  intervalScore,
  passesBar,
  scoreBaselines,
  scoreConformal,
  CONFORMAL_WINDOW,
  scoreByType,
  scoreCost,
  scoreGroups,
  scoreDrift,
  scoreRuns,
  scoreSteps,
  speedFactor,
  stepFraction,
  taskFraction,
  typicalError,
  wilson,
  LEVELS,
  REPLAY_WINDOW,
  agentTail,
  remainingWithAgents,
  replayAgentsAtStep,
  withAgents,
  AGENT_LIMIT,
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

  test('at submit the replay knows only the labels known then; the run\'s own labels only when asked', () => {
    // wrap runs: those that end up editing in the website folder take ten times longer, and only show it once they do,
    // so every run's project at submit is none. Twelve website runs and twelve without, alternating.
    const runs = Array.from({ length: 24 }, (_, i) => {
      const website = i % 2 === 1
      return { ...timed(`p${i}`, i * 3_600_000, website ? 600 : 60, { project: website ? 'website' : null }), submitTaskType: 'wrap', submitProject: null }
    })
    const probe = (options?: Parameters<typeof replay>[1]) => replay(runs, options).find(r => r.runId === 'p23')
    // at submit (the default): no project, so the type-wide figure, the website runs and the others together
    const atSubmit = probe()
    expect(atSubmit?.level).toBe('type+model')
    expect(atSubmit?.n).toBe(23)
    expect(atSubmit?.submit?.usualMs).toBe(60_000)
    expect(atSubmit).toEqual(probe({ queryOf: r => ({ ...r, project: null, shape: undefined }) }))
    // with the labels known (the run's own, final ones): the website runs alone, which a run cannot know at submit
    const known = probe({ labels: 'final' })
    expect(known?.level).toBe('type+project+model')
    expect(known?.submit?.usualMs).toBe(600_000)
    expect(known).toEqual(probe({ queryOf: r => ({ ...r, shape: undefined }) }))
  })

  test('at submit a run is matched under the task type known then, and scored under it', () => {
    // freeform runs of 60 s, and runs that load the wrap skill only after their second request (600 s):
    // at submit both are freeform, so the wrap runs are matched against freeform history
    const runs = Array.from({ length: 30 }, (_, i) => {
      const wrap = i % 3 === 2
      return { ...timed(`t${i}`, i * 3_600_000, wrap ? 600 : 60, { taskType: wrap ? 'wrap' : 'freeform' }), submitTaskType: 'freeform', submitProject: null }
    })
    const late = replay(runs).find(r => r.runId === 't29')
    expect(late).toMatchObject({ taskType: 'wrap', queryType: 'freeform', n: 20 })
    expect(late?.submit?.usualMs).toBe(60_000)
    // the self-score (and its correction, which live looks up by the task type it knows) is keyed the same way
    const scores = scoreRuns(runs)
    expect(Object.keys(scores)).toEqual(['freeform'])
    // runs 7 to 29 have five freeform runs behind them; the wrap runs among them miss the freeform figure
    expect(scores.freeform?.n).toBe(23)
    expect(near(scores.freeform?.coverage, 15 / 23)).toBe(true)
    // what the live runs showed is scored under the same key: the ten wrap runs kept an estimate made as freeform
    const shownRuns = runs.map(r => (r.taskType === 'wrap' ? { ...r, eta: { usualMs: 60_000, slowMs: 60_000 } } : r))
    expect(scoreRuns(shownRuns).freeform?.shown).toEqual({ n: 10, coverage: 0 })
    // once the labels are known, each type is matched and scored on its own
    const final = scoreRuns(runs, { labels: 'final' })
    expect(Object.keys(final).sort()).toEqual(['freeform', 'wrap'])
    expect(scoreRuns(shownRuns, { labels: 'final' }).wrap?.shown).toEqual({ n: 10, coverage: 0 })
    expect(replay(runs, { labels: 'final' }).find(r => r.runId === 't29')).toMatchObject({ taskType: 'wrap', queryType: 'wrap', n: 9 })
  })

  test('the correction fitted at submit holds at submit: final labels would fit one that under-covers live', () => {
    // the reviewer's case: 400 runs of one type, 40% end up in the website folder and take ten times longer;
    // live, the project is unknown at submit for every one of them
    let seed = 99
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    const normal = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd())
    const runs = Array.from({ length: 400 }, (_, i) => {
      const website = rnd() < 0.4
      const ms = Math.round(Math.exp(0.4 * normal()) * (website ? 600_000 : 60_000))
      return { ...timed(`w${i}`, i * 3_600_000, ms / 1000, { project: website ? 'website' : null }), submitTaskType: 'wrap', submitProject: null }
    })
    // what live has at submit: the slow figure from the project-less query, times the correction it fitted
    const liveCoverage = (factor: number) => {
      const rows = replay(runs, { queryOf: r => ({ ...r, project: null, shape: undefined }) }).flatMap(r => (r.submit ? [r] : []))
      return rows.filter(r => r.actualMs <= Math.max(r.submit?.usualMs ?? 0, (r.submit?.slowMs ?? 0) * factor)).length / rows.length
    }
    const fitted = scoreRuns(runs).wrap?.factor ?? 1
    const leaky = scoreRuns(runs, { labels: 'final' }).wrap?.factor ?? 1
    // the correction fitted at submit lands within sampling noise of the 80% target live
    expect(Math.abs(liveCoverage(fitted) - 0.8) < 0.03).toBe(true)
    // the one fitted with each run's final project shrinks the slow figure and leaves live well short
    expect(leaky < 0.75).toBe(true)
    expect(liveCoverage(leaky) < 0.7).toBe(true)
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

describe('the matcher against naive baselines', () => {
  const HOUR = 3_600_000
  const steady = (n = 9, type = 'wrap', from = 0) => Array.from({ length: n }, (_, i) => timed(`${type}${i}`, from + i * HOUR, 100, { taskType: type }))

  test('every predictor is scored on the runs all of them can predict', () => {
    const got = scoreBaselines(steady())
    // nine runs: the first five have too few behind them, four are scored
    expect(got.all?.n).toBe(4)
    for (const name of ['matcher', 'matcherCorrected', 'type', 'global'] as const) {
      const p = got.all?.predictors[name]
      expect(p?.coverage).toBe(1)
      expect(p?.spread).toBe(1)
      expect(p?.slowMs).toBe(100_000)
      expect(p?.error).toBe(0)
    }
    expect(got.wrap?.n).toBe(4)
  })

  test('a run that starts later never changes an earlier prediction, even one that overlaps it', () => {
    const seq = steady(9)
    // another type, started inside the sequence and ended long after it: it must not reach the global pool of anything that started before it ended
    const poison = timed('poison', 6 * HOUR + 1000, 99_999, { taskType: 'other' })
    // and one that comes after everything
    const later = timed('later', 100 * HOUR, 5000, { taskType: 'other' })
    const got = scoreBaselines([...seq, poison, later])
    expect(got.all?.predictors.global.slowMs).toBe(100_000)
    expect(got.all?.predictors.type.slowMs).toBe(100_000)
    expect(got.all?.predictors.matcher.slowMs).toBe(100_000)
    // nothing about the later runs shows in the wrap runs' scores
    expect(got.wrap).toEqual(scoreBaselines(seq).wrap)
  })

  test('at matched coverage a loose predictor is scaled down to the matcher\'s hit rate', () => {
    // wrap runs of 100 s, and a slow other type of 1000 s runs sprinkled in: the global p80 is far too wide for wrap
    const wrap = steady(12)
    const other = steady(8, 'other', 30 * 60_000).map(r => ({ ...r, agentMs: 1_000_000, endedAt: r.startedAt + 1_000_000 }))
    const got = scoreBaselines([...wrap, ...other])
    const w = got.wrap?.predictors
    expect(w?.matcher.scale).toBe(1)
    expect((w?.global.scale ?? 9) < 1).toBe(true)
    expect((w?.global.equal.slowMs ?? 9e9) < (w?.global.slowMs ?? 0)).toBe(true)
    // the type baseline and the matcher agree on a steady type
    expect(w?.type.slowMs).toBe(w?.matcher.slowMs)
  })

  test('the corrected matcher uses only earlier runs to fit its correction', () => {
    // 100 s runs then a 10x outlier: the outlier is scored with the correction fitted before it ran
    const seq = [...steady(8), timed('big', 20 * HOUR, 1000)]
    const got = scoreBaselines(seq)
    // 3 steady runs scored plus the outlier; the outlier missed the slow figure
    expect(got.all?.n).toBe(4)
    expect(near(got.all?.predictors.matcher.coverage, 0.75)).toBe(true)
  })
})

describe('scoring cost and groups', () => {
  const HOUR = 3_600_000
  const costed = (n: number, usd: number | null, extra: Record<string, unknown> = {}) =>
    Array.from({ length: n }, (_, i) => ({ ...timed(`c${i}`, i * HOUR, 100, { usd }), unpricedTurns: 0, ...extra }))

  test('cost coverage and typical miss, per type and overall', () => {
    const got = scoreCost(costed(9, 0.5) as never)
    expect(got.wrap).toEqual({ n: 4, coverage: 1, error: 0 })
    expect(got.all).toEqual(got.wrap)
  })

  test('runs with no cost, or a part cost, are neither history nor scored', () => {
    const rows = [...costed(9, 0.5), { ...timed('part', 10 * HOUR, 100, { usd: 9 }), unpricedTurns: 1 }, timed('none', 11 * HOUR, 100, { usd: null })]
    expect(scoreCost(rows as never).all).toEqual(scoreCost(costed(9, 0.5) as never).all)
    expect(scoreCost(costed(9, null) as never)).toEqual({})
  })

  test('a later run does not change an earlier cost prediction', () => {
    const early = costed(9, 0.5)
    const later = { ...timed('later', 50 * HOUR, 100, { usd: 500 }), unpricedTurns: 0 }
    const withLater = replay([...early, later] as never)
    const without = replay(early as never)
    for (const r of without) expect(withLater.find(w => w.runId === r.runId)?.cost).toEqual(r.cost)
  })

  test('scoreGroups scores any grouping, and leaves out a null key', () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({ ...timed(`g${i}`, i * HOUR, 100), shape: i % 3 === 0 ? 'edit' : 'read' }))
    const got = scoreGroups(rows as never, r => (r.runId === 'g8' ? null : ((r as unknown as { shape: string }).shape)))
    expect(got.edit?.coverage).toBe(1)
    expect((got.edit?.n ?? 0) + (got.read?.n ?? 0)).toBe(3)
  })
})

describe('wilson interval', () => {
  test('known values, bounds and the empty case', () => {
    expect(wilson(0, 0)).toBe(null)
    const half = wilson(5, 10)
    expect(Math.abs((half?.lo ?? 0) - 0.2366) < 1e-3).toBe(true)
    expect(Math.abs((half?.hi ?? 0) - 0.7634) < 1e-3).toBe(true)
    // all of 10 never reaches past 1, and the lower end is well below 1
    const all = wilson(10, 10)
    expect(all?.hi).toBe(1)
    expect((all?.lo ?? 1) < 0.75).toBe(true)
    // more runs, tighter interval
    const wide = wilson(8, 10)
    const tight = wilson(800, 1000)
    expect((tight?.hi ?? 0) - (tight?.lo ?? 0) < (wide?.hi ?? 0) - (wide?.lo ?? 0)).toBe(true)
  })
})

describe('out-of-sample baselines', () => {
  const HOUR = 3_600_000
  const steady = (n: number, type = 'wrap', from = 0) => Array.from({ length: n }, (_, i) => timed(`${type}${i}`, from + i * HOUR, 100, { taskType: type }))

  test('the holdout is the last 30% of scored runs by start time, fitted on the first 70%', () => {
    const got = scoreBaselines(steady(25)).all
    // 25 runs, the first five too thin: 20 scored, 14 train and 6 held out
    expect(got?.n).toBe(20)
    expect(got?.holdout?.trainN).toBe(14)
    expect(got?.holdout?.n).toBe(6)
  })

  test('the scale is fitted on the training runs only: a change after the split cannot leak into it', () => {
    // 100 s runs, then the last 30% (by start) are ten times slower
    const calm = steady(20)
    const slowTail = Array.from({ length: 5 }, (_, i) => timed(`tail${i}`, (20 + i) * HOUR, 1000))
    const got = scoreBaselines([...calm, ...slowTail]).all
    // train is all steady, so the per-type figure fits a scale of 1 and the held-out runs show what that does to coverage
    expect(got?.holdout?.predictors.type.scale).toBe(1)
    expect((got?.holdout?.predictors.type.coverage ?? 1) < 0.5).toBe(true)
    // making the tail even slower changes the held-out coverage but not the fitted scale
    const slower = Array.from({ length: 5 }, (_, i) => timed(`tail${i}`, (20 + i) * HOUR, 5000))
    const again = scoreBaselines([...calm, ...slower]).all
    expect(again?.holdout?.predictors.type.scale).toBe(got?.holdout?.predictors.type.scale)
  })

  test('the held-out rows are all later than the training rows', () => {
    const rows = [...steady(25), ...steady(25, 'other', 30 * HOUR)]
    const got = scoreBaselines(rows)
    // a type is split at the same moment as everything else: the earlier type is all train, none held out for the late one
    expect((got.all?.holdout?.n ?? 0) + (got.all?.holdout?.trainN ?? 0)).toBe(got.all?.n ?? -1)
    for (const key of ['wrap', 'other']) {
      const g = got[key]
      expect((g?.holdout?.n ?? 0) + (g?.holdout?.trainN ?? 0) <= (g?.n ?? 0)).toBe(true)
    }
  })

  test('too few runs leave no holdout', () => {
    expect(scoreBaselines(steady(5)).all?.n).toBe(0)
    expect(scoreBaselines(steady(5)).all?.holdout).toBe(null)
    expect(scoreBaselines(steady(6)).all?.holdout).toBe(null)
  })

  test('the matcher keeps a scale of 1 out of sample', () => {
    expect(scoreBaselines(steady(25)).all?.holdout?.predictors.matcher.scale).toBe(1)
  })

  test('the holdout also scores each slow figure as it stands, by its interval score per run', () => {
    // 100 s runs, then five of 1000 s: the six held-out runs are the last steady one and the five long ones
    const calm = steady(20)
    const slowTail = Array.from({ length: 5 }, (_, i) => timed(`tail${i}`, (20 + i) * HOUR, 1000))
    const h = scoreBaselines([...calm, ...slowTail]).all?.holdout
    // every uncorrected figure still says 100 s, as the long runs stay above the 80th percentile of the history:
    // 100 s for the steady run, then 100 + 5 x 900 for each long one
    const close = (a: number | null | undefined, b: number) => typeof a === 'number' && Math.abs(a - b) < 1e-3
    for (const name of ['matcher', 'type', 'global'] as const) {
      const p = h?.predictors[name]
      expect(p?.raw.coverage).toBe(1 / 6)
      expect(p?.raw.hits).toBe(1)
      expect(p?.raw.slowMs).toBe(100_000)
      expect(p?.scores.length).toBe(6)
      expect((p?.scores ?? []).every((s, i) => close(s, i === 0 ? 100_000 : 4_600_000))).toBe(true)
      expect(close(p?.score, (100_000 + 5 * 4_600_000) / 6)).toBe(true)
    }
    // the corrected matcher, fitted on its latest 50 scored runs, widens to x4 on the last long run: 400 + 5 x 600
    expect(close(h?.predictors.matcherCorrected.scores.at(-1), 3_400_000)).toBe(true)
  })

  test('cost is scored the same way, over runs whose cost is known whole', () => {
    const priced = steady(25).map(r => ({ ...r, usd: 1, unpricedTurns: 0 }))
    const unpriced = [{ ...timed('free', 30 * HOUR, 100), usd: null }, { ...timed('part', 31 * HOUR, 100), usd: 5, unpricedTurns: 1 }]
    const cost = scoreBaselines([...priced, ...unpriced] as never, { measure: 'cost' }).all
    expect(cost?.n).toBe(20)
    expect(cost?.holdout?.n).toBe(6)
    expect(cost?.holdout?.predictors.type.raw.slowMs).toBe(1)
    expect(cost?.holdout?.predictors.matcher.score).toBe(1)
    // time counts every run, priced or not
    expect(scoreBaselines([...priced, ...unpriced] as never).all?.n).toBe(22)
  })
})

describe('the interval score', () => {
  test('the slow figure plus five times any overrun at 80%', () => {
    expect(intervalScore(100, 80)).toBe(100)
    expect(intervalScore(100, 100)).toBe(100)
    expect(near(intervalScore(100, 120), 200)).toBe(true)
    // at 90% the overrun counts ten times
    expect(near(intervalScore(100, 120, 0.9), 300)).toBe(true)
  })

  test('proper: over many runs the mean is lowest at the 80th percentile, not narrower or wider', () => {
    // actual times 1 to 100: the 80th percentile is 80
    const actual = Array.from({ length: 100 }, (_, i) => i + 1)
    const mean = (slow: number) => actual.reduce((s, a) => s + intervalScore(slow, a), 0) / actual.length
    const best = [40, 60, 70, 80, 90, 100, 120].reduce((b, s) => (mean(s) < mean(b) ? s : b))
    expect(best).toBe(80)
  })
})

describe('the paired bootstrap', () => {
  test('a clear winner wins every resample, a loser none, and a tie is no win', () => {
    const a = Array.from({ length: 50 }, (_, i) => 10 + (i % 5))
    const b = a.map(x => x + 1)
    expect(bootstrapWins(a, b)).toBe(1)
    expect(bootstrapWins(b, a)).toBe(0)
    expect(bootstrapWins(a, a)).toBe(0)
    expect(bootstrapWins([], [])).toBe(null)
  })

  test('seeded, so the same scores give the same rate; a gap carried by one run wins only the resamples that draw it', () => {
    const a = Array.from({ length: 150 }, () => 100)
    const b = a.map((x, i) => (i === 149 ? 2000 : x))
    const rate = bootstrapWins(a, b)
    expect(rate).toBe(bootstrapWins(a, b))
    // a resample draws that run at least once about 1 - 1/e of the time
    expect((rate ?? 0) > 0.55 && (rate ?? 1) < 0.72).toBe(true)
  })
})

describe('the baseline verdict', () => {
  const pred = (scores: number[]) => ({ coverage: 0.8, hits: 0, spread: 3, slowMs: 1, scale: 1, raw: { coverage: 0.8, hits: 0, slowMs: 1 }, score: scores.reduce((s, x) => s + x, 0) / scores.length, scores })
  const score = (matcher: number[], type: number[]) => {
    const n = matcher.length
    return { n, predictors: {}, holdout: { n, trainN: 2 * n, predictors: { matcher: pred(matcher), matcherCorrected: pred(matcher), type: pred(type), global: pred(type) } } } as never
  }
  /** n runs' scores spread around `level`, the same spread at every level, so a pair differs only by the level. */
  const around = (n: number, level: number) => Array.from({ length: n }, (_, i) => level + ((i * 37) % 21) - 10)

  test('yes when the matcher scores at least 5% lower and stays lower in 90% of resamples; no by the mirror rule', () => {
    const v = baselineVerdict(score(around(150, 90), around(150, 100)))
    expect(v.verdict).toBe('yes')
    expect(v.winRate).toBe(1)
    expect((v.ratio ?? 1) < 0.95).toBe(true)
    expect(near(v.matcherScore, (around(150, 90).reduce((s, x) => s + x, 0)) / 150)).toBe(true)
    expect(baselineVerdict(score(around(150, 110), around(150, 100))).verdict).toBe('no')
  })

  test('within 5% either way is unclear, even when it holds in every resample', () => {
    expect(baselineVerdict(score(around(150, 97), around(150, 100))).verdict).toBe('unclear')
    expect(baselineVerdict(score(around(150, 103), around(150, 100))).verdict).toBe('unclear')
  })

  test('a gap carried by one run is unclear: it does not hold in 90% of resamples', () => {
    const v = baselineVerdict(score(Array.from({ length: 150 }, () => 100), Array.from({ length: 150 }, (_, i) => (i === 0 ? 2000 : 100))))
    expect((v.ratio ?? 1) <= 0.95).toBe(true)
    expect((v.winRate ?? 1) < 0.9).toBe(true)
    expect(v.verdict).toBe('unclear')
  })

  test('under 100 held-out runs is unclear', () => {
    expect(baselineVerdict(score(around(99, 50), around(99, 100))).verdict).toBe('unclear')
    expect(baselineVerdict(score(around(100, 50), around(100, 100))).verdict).toBe('yes')
  })

  test('nothing held out is unclear', () => {
    expect(baselineVerdict(undefined).verdict).toBe('unclear')
    expect(baselineVerdict({ n: 3, predictors: {}, holdout: null } as never).verdict).toBe('unclear')
  })
})

describe('conformal calibration of the slow figure', () => {
  const HOUR = 3_600_000
  /** n runs of one type, one an hour, run i taking `seconds(i)`. */
  const series = (n: number, seconds: (i: number) => number) => Array.from({ length: n }, (_, i) => timed(`s${i}`, i * HOUR, seconds(i)))
  const varied = (i: number) => 60 + ((i * 37) % 100)

  test('the conformal factor is the ceil((n + 1) x 0.8)-th smallest ratio, not interpolated', () => {
    // n = 8: rank ceil(9 x 0.8) = 8, the largest
    const eight = [0.5, 0.6, 0.7, 0.8, 0.9, 1.2, 1.5, 2].map(r => ({ slowMs: 100, actualMs: 100 * r }))
    expect(calibrate(eight, { conformal: true }).factor).toBe(2)
    // n = 10: rank ceil(11 x 0.8) = 9, against the interpolated 80th percentile
    const ten = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.5, 2].map(r => ({ slowMs: 100, actualMs: 100 * r }))
    expect(calibrate(ten, { conformal: true }).factor).toBe(1.5)
    expect(near(calibrate(ten).factor, 1.2 + (1.5 - 1.2) * 0.2)).toBe(true)
    // too few to promise the target: five runs at 95% need rank 6
    expect(calibrate(eight.slice(0, 5), { conformal: true, target: 0.95 }).factor).toBe(1)
    // held to 0.5..4 like the fitted one, and 1 under five runs
    expect(calibrate(eight.map(s => ({ ...s, actualMs: s.actualMs * 10 })), { conformal: true }).factor).toBe(4)
    expect(calibrate(eight.slice(0, 4), { conformal: true }).factor).toBe(1)
  })

  test('`recent` fits the factor on the latest runs only, while n and coverage count them all', () => {
    const old = Array.from({ length: 20 }, () => ({ slowMs: 100, actualMs: 300 }))
    const now = Array.from({ length: 10 }, () => ({ slowMs: 100, actualMs: 100 }))
    const all = calibrate([...old, ...now])
    const recent = calibrate([...old, ...now], { recent: 10, conformal: true })
    expect(all.factor).toBe(3)
    expect(recent.factor).toBe(1)
    expect(recent.n).toBe(30)
    expect(recent.coverage).toBe(all.coverage)
  })

  test('scored on the same held-out runs as the baselines', () => {
    const runs = series(60, varied)
    const conf = scoreConformal(runs)
    const hold = scoreBaselines(runs).all?.holdout
    expect(conf?.n).toBe(hold?.n)
    expect(conf?.trainN).toBe(hold?.trainN)
    expect(conf?.recent).toBe(CONFORMAL_WINDOW)
    expect(conf?.rows.length).toBe(conf?.n)
  })

  test('the fitted figure is the live correction over every earlier scored run; conformal is calibrate over the latest of them', () => {
    const runs = series(40, varied)
    const conf = scoreConformal(runs, { recent: 10 })
    const replayed = replay(runs)
    expect((conf?.rows.length ?? 0) > 5).toBe(true)
    for (const row of conf?.rows ?? []) {
      const start = runs.find(r => r.runId === row.runId)?.startedAt ?? 0
      // no run overlaps another here, so start order is end order
      const earlier = replayed.filter(r => r.startedAt < start).flatMap(r => (r.submit ? [{ slowMs: r.submit.slowMs, actualMs: r.actualMs }] : []))
      const own = replayed.find(r => r.runId === row.runId)?.submit ?? { usualMs: 0, slowMs: 0 }
      const at = (factor: number) => Math.max(own.usualMs, own.slowMs * factor)
      expect(near(row.fittedMs, at(calibrate(earlier).factor))).toBe(true)
      expect(near(row.conformalMs, at(calibrate(earlier.slice(-10), { conformal: true }).factor))).toBe(true)
    }
  })

  test('a run is calibrated only on runs that ended before it started: an overlapping run changes nothing, an earlier one does', () => {
    const runs = series(40, varied)
    const before = new Map((scoreConformal(runs)?.rows ?? []).map(r => [r.runId, r]))
    // the same type, started before the last ten and still going when all of them started, ten hours long and far over any slow figure
    const overlap = timed('overlap', 30 * HOUR + 1000, 36_000)
    const shared = (scoreConformal([...runs, overlap])?.rows ?? []).filter(r => before.has(r.runId))
    expect(shared.length > 5).toBe(true)
    for (const r of shared) expect(r).toEqual(before.get(r.runId))
    // the check can fail: the same run made twenty times longer, still ending before the next one starts, moves the held-out figures
    const longer = runs.map(r => (r.runId === 's10' ? { ...r, agentMs: r.agentMs * 20, endedAt: r.startedAt + r.agentMs * 20 } : r))
    const moved = (scoreConformal(longer)?.rows ?? []).some(r => {
      const b = before.get(r.runId)
      return b !== undefined && (b.fittedMs !== r.fittedMs || b.conformalMs !== r.conformalMs)
    })
    expect(moved).toBe(true)
  })

  test('the window follows a change: once slow runs give way to quick ones, conformal tightens while the fitted correction lags', () => {
    // 60 runs, each longer than all before it (so each overruns its slow figure), then 60 steady ones
    const runs = series(120, i => (i < 60 ? 100 + 10 * i : 100))
    const conf = scoreConformal(runs, { recent: 20 })
    expect(conf?.fitted.coverage).toBe(1)
    expect(conf?.conformal.coverage).toBe(1)
    expect((conf?.conformal.slowMs ?? Infinity) < (conf?.fitted.slowMs ?? 0)).toBe(true)
    expect((conf?.conformal.score ?? Infinity) < (conf?.fitted.score ?? 0)).toBe(true)
  })

  test('the bar for live use: coverage closer to 80% with a median slow figure no wider', () => {
    expect(passesBar({ coverage: 0.86, slowMs: 100 }, { coverage: 0.81, slowMs: 100 })).toBe(true)
    expect(passesBar({ coverage: 0.74, slowMs: 100 }, { coverage: 0.78, slowMs: 95 })).toBe(true)
    expect(passesBar({ coverage: 0.86, slowMs: 100 }, { coverage: 0.81, slowMs: 101 })).toBe(false)
    expect(passesBar({ coverage: 0.82, slowMs: 100 }, { coverage: 0.82, slowMs: 90 })).toBe(false)
    expect(passesBar({ coverage: 0.8, slowMs: null }, { coverage: 0.8, slowMs: 1 })).toBe(false)
  })

  test('too few runs hold nothing out', () => {
    expect(scoreConformal(series(6, () => 100))).toBe(null)
    expect(scoreConformal([])).toBe(null)
  })

  test('1,500 runs of one type score fast: conformal, and the baselines on time and cost', () => {
    const runs = series(1500, i => 30 + ((i * 37) % 400))
    const t0 = Date.now()
    scoreConformal(runs)
    scoreBaselines(runs)
    scoreBaselines(runs, { measure: 'cost' })
    expect(Date.now() - t0).toBeLessThan(600)
  })
})

describe('drift by month and model', () => {
  const DAYMS = 86_400_000
  const base = new Date(2026, 8, 5, 12).getTime()
  /** n runs of the type, one an hour, whose actual time is `seconds` each (100 s is what history says). */
  const batch = (prefix: string, n: number, from: number, seconds: (i: number) => number, model = 'claude-opus-5-5') =>
    Array.from({ length: n }, (_, i) => timed(`${prefix}${i}`, from + i * HOUR_MS, seconds(i), { model }))
  const HOUR_MS = 3_600_000

  test('steady runs across two months: no drift', () => {
    const rows = [...batch('a', 60, base, () => 100), ...batch('b', 60, base + 40 * DAYMS, () => 100)]
    const got = scoreDrift(rows)
    expect(got.byMonth.length).toBe(2)
    expect(got.drift).toBe('no')
  })

  test('a month whose runs all overshoot the slow figure is drift', () => {
    const rows = [...batch('a', 60, base, () => 100), ...batch('b', 60, base + 40 * DAYMS, i => 200 + i * 100)]
    const got = scoreDrift(rows)
    expect(got.drift).toBe('yes')
    const second = got.byMonth[1]
    expect((second?.coverage ?? 1) < 0.2).toBe(true)
  })

  test('groups split by main model, and small groups cannot show drift', () => {
    const rows = [...batch('a', 40, base, () => 100), ...batch('b', 6, base + 5 * DAYMS, () => 1000, 'claude-sonnet-5-5')]
    const got = scoreDrift(rows)
    expect(got.byModel.map(g => g.key)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(got.drift).toBe('unclear')
  })

  test('one month of one model has nothing to compare', () => {
    expect(scoreDrift(batch('a', 40, base, () => 100)).drift).toBe('unclear')
    expect(scoreDrift([]).byMonth).toEqual([])
  })
})

describe('the subagent-aware estimate', () => {
  const s = (n: number) => n * 1000
  // ten past worker agents of 10 to 100 s; five tails of nothing
  const tens = Array.from({ length: 10 }, (_, i) => s(10 + i * 10))
  const durations = new Map<string, number[]>([
    ['worker', tens],
    ['quick', Array.from({ length: 10 }, (_, i) => s(1 + i))],
    ['rare', [s(10), s(20), s(30), s(40)]],
  ])
  const none = [0, 0, 0, 0, 0]

  test('one agent: the median and 80th percentile of its type, less what it has run', () => {
    expect(remainingWithAgents([{ type: 'worker', ranMs: 0 }], durations, none)).toEqual({ usualMs: s(50), slowMs: s(80) })
    // 55 s in: only the 60 to 100 s agents were still going then, 5 to 45 s more
    expect(remainingWithAgents([{ type: 'worker', ranMs: s(55) }], durations, none)).toEqual({ usualMs: s(25), slowMs: s(35) })
  })

  test('parallel agents finish with the slowest: the max, not the sum', () => {
    // two alike: P(both done by x) = F(x)^2, so the median is where F reaches 0.71 and the slow figure where it reaches 0.89
    const pair = remainingWithAgents([{ type: 'worker', ranMs: 0 }, { type: 'worker', ranMs: 0 }], durations, none)
    expect(pair).toEqual({ usualMs: s(80), slowMs: s(90) })
    // longer than one alone, far shorter than the two medians added up (100 s)
    expect((pair?.usualMs ?? 0) < s(100)).toBe(true)
    // a quick agent beside a slow one changes nothing
    expect(remainingWithAgents([{ type: 'worker', ranMs: 0 }, { type: 'quick', ranMs: 0 }], durations, none)).toEqual({ usualMs: s(50), slowMs: s(80) })
  })

  test("the main loop's tail comes after the last agent returns", () => {
    expect(remainingWithAgents([{ type: 'worker', ranMs: 0 }], durations, [s(10), s(10), s(10), s(10), s(10)])).toEqual({ usualMs: s(60), slowMs: s(90) })
    // an agent that always takes 30 s, then a tail of 0 to 40 s: 30 s plus the tail's own median and 80th percentile
    const fixed = new Map([['fixed', [s(30), s(30), s(30), s(30), s(30)]]])
    expect(remainingWithAgents([{ type: 'fixed', ranMs: 0 }], fixed, [0, s(10), s(20), s(30), s(40)])).toEqual({ usualMs: s(50), slowMs: s(60) })
  })

  test('no usable agent history: nothing going, a thin or unknown type, an agent past nearly all its kind, or too few tails', () => {
    expect(remainingWithAgents([], durations, none)).toBe(null)
    expect(remainingWithAgents([{ type: 'rare', ranMs: 0 }], durations, none)).toBe(null)
    expect(remainingWithAgents([{ type: 'unknown', ranMs: 0 }], durations, none)).toBe(null)
    // 95 s in: only the 100 s agent ran longer, under the three survivors needed
    expect(remainingWithAgents([{ type: 'worker', ranMs: s(95) }], durations, none)).toBe(null)
    // one unusable agent among usable ones sends the whole estimate back to history
    expect(remainingWithAgents([{ type: 'worker', ranMs: 0 }, { type: 'rare', ranMs: 0 }], durations, none)).toBe(null)
    expect(remainingWithAgents([{ type: 'worker', ranMs: 0 }], durations, [0, 0, 0, 0])).toBe(null)
  })

  test("the tail: the main loop's last activity less the last agent's return, never below 0", () => {
    const base = { runId: 'r', taskType: 'wrap', project: null, model: null, agentMs: 1, usd: null, startedAt: 0, endedAt: 500 }
    expect(agentTail({ ...base, agents: [{ type: 'w', startedAt: 0, endedAt: 100 }, { type: 'w', startedAt: 0, endedAt: 150 }], mainLastAt: 200 })).toBe(50)
    expect(agentTail({ ...base, agents: [{ type: 'w', startedAt: 0, endedAt: 300 }], mainLastAt: 200 })).toBe(0)
    expect(agentTail({ ...base, agents: [{ type: 'w', startedAt: 0, endedAt: 300 }] })).toBe(200)
    expect(agentTail({ ...base, agents: [] })).toBe(null)
  })

  // a run of 300 s with one worker agent from 10 s in that ran `agentS` seconds, and a tail of `tailS`
  const H = 3_600_000
  const agentRun = (id: string, startedAt: number, agentS: number, tailS: number, endedAt?: number) => {
    const agentEnd = startedAt + s(10) + s(agentS)
    const mainLastAt = agentEnd + s(tailS)
    return { runId: id, taskType: 'wrap', project: null, model: null, agentMs: s(300), usd: null, startedAt, endedAt: endedAt ?? mainLastAt, mainLastAt, agents: [{ type: 'worker', startedAt: startedAt + s(10), endedAt: agentEnd }] }
  }
  const history = Array.from({ length: 6 }, (_, i) => agentRun(`h${i}`, i * H, 100, 20))
  const target = agentRun('t', 10 * H, 190, 0)
  const stateOf = (r: { runId: string; startedAt: number }) => (r.runId === 't' ? { elapsedMs: s(30), at: r.startedAt + s(30) } : null)

  test('the replay reads only runs that ended before the run started: no leakage from itself or an overlapping run', () => {
    const [row] = replayAgentsAtStep([...history, target], { stateOf })
    // its agent has run 20 s: 80 s more by every past worker, then their 20 s tail, on top of the 30 s gone
    expect(row).toEqual({ runId: 't', startedAt: 10 * H, actualMs: s(300), going: 1, agents: { usualMs: s(130), slowMs: s(130) } })
    // a run that started before it but ended after it started, however different, changes nothing
    const overlapping = agentRun('o', 10 * H - s(5), 1000, 500)
    expect(replayAgentsAtStep([...history, overlapping, target], { stateOf })).toEqual([row])
    // the run's own agent, however long, is never its own history
    expect(replayAgentsAtStep([...history, { ...target, agents: [{ type: 'worker', startedAt: target.startedAt + s(10), endedAt: target.startedAt + s(5000) }] }], { stateOf })[0]?.agents).toEqual(row?.agents)
    // one that ended before it started does count
    const earlier = Array.from({ length: 6 }, (_, i) => agentRun(`e${i}`, 7 * H + i * 1000, 300, 20, 8 * H))
    expect(replayAgentsAtStep([...history, ...earlier, target], { stateOf })[0]?.agents?.slowMs).toBeGreaterThan(s(130))
  })

  test('agents going at the state: started by then and not yet back; the same runs as the step replay', () => {
    // at 5 s in the agent has not started, so nothing is going
    const before = replayAgentsAtStep([...history, target], { stateOf: r => (r.runId === 't' ? { elapsedMs: s(5), at: r.startedAt + s(5) } : null) })
    expect(before).toEqual([{ runId: 't', startedAt: 10 * H, actualMs: s(300), going: 0, agents: null }])
    // at 250 s it is back
    expect(replayAgentsAtStep([...history, target], { stateOf: r => (r.runId === 't' ? { elapsedMs: s(250), at: r.startedAt + s(250) } : null) })[0]?.going).toBe(0)
    // a state at or past the run's own time is left out, as replayAtStep does
    expect(replayAgentsAtStep([...history, target], { stateOf: r => (r.runId === 't' ? { elapsedMs: s(300), at: r.startedAt + s(30) } : null) })).toEqual([])
    // the newest AGENT_LIMIT agents of a type are read: older ones of another length drop out
    const old = Array.from({ length: AGENT_LIMIT }, (_, i) => agentRun(`old${i}`, i * 1000, 1000, 20, 1 * H))
    const recent = Array.from({ length: AGENT_LIMIT }, (_, i) => agentRun(`new${i}`, 2 * H + i * 1000, 100, 20, 3 * H))
    expect(replayAgentsAtStep([...old, ...recent, target], { stateOf })[0]?.agents).toEqual({ usualMs: s(130), slowMs: s(130) })
  })

  test('the step rows take the subagent-aware figure where it has one, and keep their own rows', () => {
    const steps = [
      { runId: 'a', taskType: 'wrap', startedAt: 0, actualMs: 100, level: 'type', n: 5, step: { usualMs: 50, slowMs: 80 } },
      { runId: 'b', taskType: 'wrap', startedAt: 1, actualMs: 100, level: 'type', n: 5, step: { usualMs: 50, slowMs: 80 } },
      { runId: 'c', taskType: 'wrap', startedAt: 2, actualMs: 100, level: null, n: 2, step: null },
    ]
    const agents = [
      { runId: 'a', startedAt: 0, actualMs: 100, going: 1, agents: { usualMs: 90, slowMs: 120 } },
      { runId: 'b', startedAt: 1, actualMs: 100, going: 0, agents: null },
      { runId: 'c', startedAt: 2, actualMs: 100, going: 1, agents: { usualMs: 90, slowMs: 120 } },
    ]
    expect(withAgents(steps, agents).map(r => [r.runId, r.step, r.going])).toEqual([
      ['a', { usualMs: 90, slowMs: 120 }, true],
      ['b', { usualMs: 50, slowMs: 80 }, false],
      ['c', null, false],
    ])
  })
})

describe('scoring replayed rows by group', () => {
  const rows = [
    { runId: 'a', actualMs: 100, submit: { usualMs: 100, slowMs: 150 }, step: { usualMs: 100, slowMs: 150 } },
    { runId: 'b', actualMs: 300, submit: { usualMs: 100, slowMs: 150 }, step: null },
    { runId: 'c', actualMs: 100, submit: null, step: { usualMs: 200, slowMs: 400 } },
    { runId: 'd', actualMs: 100, submit: { usualMs: 100, slowMs: 150 } },
  ]
  const keyOf = (r: { runId: string }) => (r.runId === 'd' ? null : r.runId === 'c' ? 'x' : 'y')

  test('coverage and miss over the rows that have the figure, null keys left out', () => {
    const got = scoreSteps(rows, keyOf, 'submit')
    expect(got.y).toEqual({ runs: 2, scored: 2, hits: 1, coverage: 0.5, error: near(got.y?.error, Math.log(3) / 2) ? got.y?.error ?? null : null })
    expect(got.x).toEqual({ runs: 1, scored: 0, hits: 0, coverage: null, error: null })
    expect(Object.keys(got).sort()).toEqual(['x', 'y'])
  })

  test('the step field is scored separately from submit', () => {
    const got = scoreSteps(rows, keyOf, 'step')
    expect(got.x?.coverage).toBe(1)
    expect(got.y?.scored).toBe(1)
    expect(got.y?.hits).toBe(1)
  })
})
