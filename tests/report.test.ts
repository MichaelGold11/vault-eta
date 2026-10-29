import { describe, expect, test } from 'claude-code/testing'

import { buildReport } from '../lib/report.mjs'

// The report on a small fixture worked out by hand: thirteen runs, eleven of
// `wrap` (nine of 100 s, then 200 s and 400 s), two `freeform`, one subagent.

const T0 = new Date(2026, 9, 18, 12, 0, 0).getTime()
const DAY = 86_400_000
const HOUR = 3_600_000
const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'

type Over = Record<string, unknown>

function row(runId: string, start: number, seconds: number, task: Over = {}, over: Over = {}) {
  const ms = seconds * 1000
  // a typed run is named by its slash command, so its task type is known at submit, as the replay requires
  const type = typeof task.taskType === 'string' ? task.taskType : 'wrap'
  const command = type === 'freeform' ? null : type
  return {
    v: 1,
    kind: 'turn',
    src: 'live',
    machineId: 'm1',
    sessionId: 's1',
    runId,
    turnId: `t-${runId}`,
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
    modelMs: ms,
    toolMs: 0,
    waitMs: 0,
    sleepMs: 0,
    outcome: 'finished',
    tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 },
    usd: 1,
    steps: [],
    tools: [],
    task: { taskType: 'wrap', skill: null, command, project: 'website', job: null, promptChars: 100, origin: 'composer', runStart: start, ...task },
    ...over,
  }
}

function fixture() {
  const seconds = [100, 100, 100, 100, 100, 100, 100, 100, 100, 200, 400]
  const rows: Over[] = seconds.map((s, i) => {
    // two old runs, then nine within the last five days, an hour apart
    const start = i === 0 ? T0 - 40 * DAY : i === 1 ? T0 - 20 * DAY : T0 - 5 * DAY + i * HOUR
    // one tool on run 2: a Bash call of 4 s (6 s with a wait of 2 s in front)
    const tools = i === 2 ? [{ at: 0, name: 'Bash', cmd: 'bun run', ms: 6000, runMs: 4000, waitMs: 2000 }, { at: 7000, name: 'Edit', ms: 1000 }] : []
    return row(`w${i}`, start, s, {}, { tools, ...(i === 2 ? { toolMs: 7000, waitMs: 2000, agentMs: 98_000 } : {}) })
  })
  // a subagent turn on the last wrap run, 20 s and 50 cents
  rows.push(row('w10', T0 - 5 * DAY + 10 * HOUR, 20, {}, { turnId: 'sub1', agentId: 'a1', agentType: 'worker-sonnet', model: SONNET, usd: 0.5 }))
  rows.push(row('f0', T0 - 2 * DAY, 30, { taskType: 'freeform', project: null }, { usd: 0.1 }))
  rows.push(row('f1', T0 - 1 * DAY, 90, { taskType: 'freeform', project: null, job: 'launch' }, { usd: 0.3 }))
  // a session row is ignored
  rows.push({ v: 1, kind: 'session', src: 'live', machineId: 'm1', sessionId: 's1', start: T0, end: T0, turns: 13 })
  return rows
}

const localDate = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

describe('the report', () => {
  const text = buildReport(fixture(), { now: T0 })
  const has = (line: string) => expect(text.split('\n')).toContain(line)

  test('frontmatter and the opening line', () => {
    const lines = text.split('\n')
    expect(lines.slice(0, 8)).toEqual([
      '---',
      'type: reference',
      'title: vault-eta report',
      `created: ${localDate(T0)}`,
      `updated: ${localDate(T0)}`,
      'tags: [vault-eta, report]',
      'generated: true',
      '---',
    ])
    expect(text).toContain(`Generated ${localDate(T0)}. 13 runs from ${localDate(T0 - 40 * DAY)} to ${localDate(T0 - 1 * DAY)}, 1 machine (m1).`)
    expect(text).toContain('Dollars at API prices: what the same work would cost on the API, not what was billed.')
  })

  test('every section is there', () => {
    for (const h of ['## Totals', '## By task type', '## By shape', '## By model', '## By project', '## By job', '## Who did the work', '## Where the time went', '## Accuracy per task type', '## Versus naive baselines', '## Conformal slow figure', '## Drift', '## Cost accuracy', '## How to read this']) {
      expect(text).toContain(h)
    }
  })

  test('totals by window', () => {
    // run time from the rows: run 2's 2 s wait on you is not run time, and the subagent's 20 s ran inside its main turn
    has('| Last 7 days | 11 | 23m 38s | $9.90 |')
    has('| Last 30 days | 12 | 25m 18s | $10.90 |')
    has('| All time | 13 | 26m 58s | $11.90 |')
  })

  test('by task type: usual is the median, slow the 80th percentile, costs include subagents', () => {
    has('| wrap | 11 | 1m 40s | 1m 40s | $1.00 | $11.50 |')
    has('| freeform | 2 | 1m 00s | 1m 18s | $0.200 | $0.400 |')
  })

  test('by model, project and job', () => {
    has('| claude-opus-5-5 | 13 | 26m 58s | $11.90 |')
    has('| website | 11 | 24m 58s | $11.50 |')
    has('| (none) | 2 | 2m 00s | $0.400 |')
    has(`| launch | 1 | 1m 30s | $0.300 | ${localDate(T0 - DAY)} | ${localDate(T0 - DAY)} |`)
  })

  test('who did the work: the main thread against each subagent type and model', () => {
    has('| main thread (opus) | 13 | 26m 58s | $11.40 |')
    has('| worker-sonnet (sonnet) | 1 | 20s | $0.500 |')
  })

  test('who did the work uses the run clock: a backfilled row\'s long quiet stretch is cut, as in the totals', () => {
    // a backfilled main row stores its whole 25 min window, but nothing ran from 10 s to 20 min: 10 s + 5 min of work
    const steps = [{ at: 0, ms: 10_000 }, { at: 1_200_000, ms: 300_000 }]
    const imported = row('i1', T0 - HOUR, 1500, {}, { src: 'backfill', steps })
    const t = buildReport([imported], { now: T0 })
    expect(t).toContain('| All time | 1 | 5m 10s |')
    expect(t).toContain('| main thread (opus) | 1 | 5m 10s |')
    expect(t).toContain('Time is each loop\'s own working time on the run clock')
  })

  test('where the time went, and the tool heads by total time', () => {
    expect(text).toContain('| Waiting on you |')
    expect(text).toContain('| Machine asleep |')
    // the Bash head keeps its first words only and counts the tool's own 4 s
    has('| Bash bun run | 1 | 4s | 4s |')
    has('| Edit | 1 | 1s | 1s |')
  })

  test('where the time went splits the run time: the main loop working, then subagents alone; a row that cannot be placed is counted', () => {
    // one run: a 60 s main turn (20 s of it a Bash call) hands work to a background agent of 300 s from 30 s; a 10 s notification turn at 340 s
    const runRows = [
      row('a1', T0 - HOUR, 60, {}, { toolMs: 20_000, tools: [{ at: 5000, name: 'Bash', cmd: 'bun test', ms: 20_000 }] }),
      row('a1', T0 - HOUR + 30_000, 300, {}, { turnId: 'sub', agentId: 'x1', agentType: 'worker-sonnet', model: SONNET, background: true }),
      row('a1', T0 - HOUR + 340_000, 10, {}, { turnId: 'n1' }),
    ]
    const t = buildReport(runRows, { now: T0 })
    // run time 0 to 330 s and 340 to 350 s: 5m 40s, of which the main loop's 70 s (20 s in tools) and the agent's 270 s alone
    expect(t).toContain('| All time | 1 | 5m 40s |')
    expect(t).toContain('| Main loop, the model working | 50s |')
    expect(t).toContain('| Main loop, tools | 20s |')
    expect(t).toContain('| Subagents alone | 4m 30s |')
    expect(t).toContain('Times are run time, the clock the band counts')
    expect(t).not.toContain('could not be placed')
    // a live row from before the recorder kept a turn's own start, with a wait that began before its window: counted, its stored time used
    const cut = row('c1', T0 - 2 * HOUR, 10, {}, { agentMs: 8000, waitMs: 2000, tools: [{ at: 0, name: 'Bash', ms: 100_000, runMs: 2000, waitMs: 98_000, asked: true }] })
    const withCut = buildReport([...runRows, cut], { now: T0 })
    expect(withCut).toContain('1 row could not be placed on the clock')
    expect(withCut).toContain('| All time | 2 | 5m 48s |')
  })

  test('accuracy: six scored runs, four under the slow estimate, a correction of x2', () => {
    // runs 5 to 10 are scored (the first five have no history): 100 s x4 covered, then 200 s and 400 s against a slow of 100 s
    has('| wrap | 6 | too few to say | x1.0 | x2.00 | - |')
    // freeform has two runs: too few to list
    expect(text.split('\n').filter(l => l.startsWith('| freeform | ')).length).toBe(1)
  })

  test('wording: a guarded live cell says the run count once, slow is beaten the right way round, and Share names its whole', () => {
    // 11 wrap runs carrying the estimate they showed: under 30, so no rate, and no "of 11" after it
    const shown = Array.from({ length: 11 }, (_, i) => row(`s${i}`, T0 - 5 * DAY + i * HOUR, 100, {}, { eta: { usualMs: 90_000, slowMs: 110_000 } }))
    const t = buildReport(shown, { now: T0 })
    expect(t).toContain('| too few to say (11 runs shown) |')
    expect(t).not.toMatch(/too few to say of \d+/)
    expect(buildReport(shown.slice(0, 1), { now: T0 })).not.toContain('1 runs shown')
    expect(t).toContain('8 runs in 10 finish under the slow figure')
    expect(t).not.toContain('is beaten by')
    expect(t).toContain('Share is of the run time plus the waiting on you and the machine asleep.')
  })

  test('no em dash, no prompt text, four lines on how to read it', () => {
    expect(text.includes(String.fromCharCode(0x2014))).toBe(false)
    const tail = text.split('## How to read this')[1]?.trim().split('\n') ?? []
    expect(tail.length).toBe(4)
  })

  test('the baseline tables compare the matcher with the per-type and global figures on the same runs, held out and in sample', () => {
    const lines = text.split('\n')
    // six wrap runs can be compared (the other seven fixture runs have too little behind them): all four predictors are listed in both tables
    expect(text).toContain("In sample, not the verdict's basis: the same 6 runs, each predicted from only the runs that ended before it started.")
    // the scale is an interpolated quantile, so the match is to within a run or so, not exact
    expect(text).toContain('"At matched coverage" scales a predictor\'s slow figure until it holds about as often as the uncorrected matcher\'s on these same runs (to within a run or so: the scale is an interpolated quantile), a fit that favours the baselines.')
    expect(text).toContain("Held out, the verdict's basis: the last 30% of the compared runs by start time (2 runs), each slow figure as it stands:")
    expect(text).toContain('| Predictor | Finished under slow | Median slow | Mean interval score |')
    for (const label of ['Matcher (uncorrected)', 'Matcher (corrected)', 'Per-type median and p80', 'Global median and p80']) {
      expect(lines.filter(l => l.startsWith(`| ${label} | `)).length).toBe(2)
    }
    // the matcher and the per-type figure agree on a single type: held out, the same hit rate, slow figure and score;
    // in sample, the same hit rate, spread, slow figure and miss (only the scaling to matched coverage differs)
    const cells = (label: string) => lines.filter(l => l.startsWith(`| ${label} | `)).map(l => l.split('|'))
    const [heldM, inM] = cells('Matcher (uncorrected)')
    const [heldT, inT] = cells('Per-type median and p80')
    expect(heldM).toEqual(heldT?.map((c, i) => (i === 1 ? ' Matcher (uncorrected) ' : c)))
    expect(inM?.slice(2, 6)).toEqual(inT?.slice(2, 6))
  })

  test('a hit rate carries a Wilson interval, and a small table says too few to say', () => {
    // the baseline table is not a table of types: six runs, five covered, 83% with an interval around it
    const line = text.split('\n').find(l => l.startsWith('| Matcher (uncorrected) | ')) ?? ''
    expect(/\| \d+% \(\d+% to \d+%\) \|/.test(line)).toBe(true)
    // a table of types under 30 runs gives no rate
    expect(text).not.toContain('| wrap | 6 | 67%')
    const many = Array.from({ length: 60 }, (_, i) => row(`m${i}`, T0 - 60 * HOUR + i * HOUR, 100))
    const big = buildReport(many, { now: T0 })
    // 54 scored runs, all inside the slow figure: 100% with the interval of 54 out of 54
    expect(big).toContain('| wrap | 55 | 100% (93% to 100%) |')
  })

  test('the verdict is computed by interval score, on time and on cost: unclear on a small holdout, and the section says why', () => {
    // the two held-out runs took 200 s and 400 s against a slow figure of 100 s from both: 100 + 5 x 100 and 100 + 5 x 300, a mean of 18m 20s
    expect(text).toContain(
      '**Verdict on time: the matcher beats the per-type median out of sample, by interval score: unclear** (mean interval score 18m 20s against 18m 20s, 0.0% lower; the matcher scored lower in 0% of 500 resamples of the 2 held-out runs, drawn 2 neighbours at a time, where the two slow figures held 0% and 0% of the time).',
    )
    expect(text).toContain('**Verdict on cost: the matcher beats the per-type median out of sample, by interval score: unclear**')
    expect(text).toContain(
      'Yes or no needs a mean score at least 5% lower that stays lower in at least 97.5% of the resamples (drawn in blocks of neighbouring runs, since runs of one session go long or short together), and at least 100 held-out runs; otherwise unclear.',
    )
    expect(text).toContain("A run's interval score is its slow figure plus five times any overrun past it")
  })

  test('conformal calibration is scored against the correction in use, and says it is not used live unless it clears the bar', () => {
    // two held-out runs are too few to show
    expect(text).toContain('## Conformal slow figure\n\nFewer than 5 runs are held out yet.')
    const many = Array.from({ length: 60 }, (_, i) => row(`m${i}`, T0 - 60 * HOUR + i * HOUR, 100))
    const big = buildReport(many, { now: T0 })
    expect(big).toContain('Split-conformal calibration of the slow figure against the correction in use, on the same 17 held-out runs.')
    // no promise it cannot keep: the factor is held at 4 (and is 1 under five runs), and the past ratios came from
    // matchers fitted on other, growing histories, so they are not exchangeable with the next run's
    expect(big).not.toContain('promises')
    expect(big).toContain(
      "It aims at 80% and guarantees nothing here: split-conformal's at-least-80% holds only when the past ratios are exchangeable with the next run's, and each of these came from a matcher fitted on a different, growing history; the factor is also held to 0.5 to 4 (1 under five runs), and past that cap it holds less often.",
    )
    expect(big).toContain('| Slow figure | Finished under slow (target 80%) | Median slow | Mean interval score |')
    // steady runs: both hold every time with the same figure; 17 held out are too few to say either is better
    expect(big).toContain('| Correction in use | 100% (82% to 100%) | 1m 40s | 1m 40s |')
    expect(big).toContain('| Conformal, latest 100 | 100% (82% to 100%) | 1m 40s | 1m 40s |')
    expect(big).toContain(
      'The live estimate keeps the correction in use: 17 held-out runs are too few to say either is better (the bar for live use needs 100, as the verdict does), so conformal stays an evaluated option.',
    )
    // from 100 held out the bar is judged: both hold every time, the same figure, so conformal is no better
    const lots = buildReport(Array.from({ length: 360 }, (_, i) => row(`l${i}`, T0 - 360 * HOUR + i * HOUR, 100)), { now: T0 })
    expect(lots).toContain(
      'The live estimate keeps the correction in use: conformal did not clear the bar for live use on these runs (the correction in use missing 80% by more than chance while conformal does not and holds closer, with a median slow figure no wider), so it stays an evaluated option.',
    )
  })

  test('drift: coverage by month and by main model, with a plain statement', () => {
    const lines = text.split('\n')
    expect(lines.some(l => l.startsWith('| month | '))).toBe(true)
    expect(lines.some(l => l.startsWith(`| main model | ${OPUS} | `))).toBe(true)
    // thirteen runs: no month or model is big enough to compare
    expect(text).toContain('Unclear: fewer than two months or models have 30 scored runs to compare.')
  })

  test('accuracy is at submit, by the task type known then; the figure once the labels are known is a row of its own', () => {
    // freeform runs of 60 s, and wrap runs of 600 s that load the skill in their third request: at submit all are freeform
    const steps = [0, 1000, 2000, 3000].map(at => ({ at, ms: 500, stop: 'tool_use' }))
    const rows = Array.from({ length: 60 }, (_, i) =>
      i % 2 === 0
        ? row(`f${i}`, T0 - 60 * HOUR + i * HOUR, 60, { taskType: 'freeform', project: null }, { steps })
        : row(`w${i}`, T0 - 60 * HOUR + i * HOUR, 600, { command: null }, { steps, tools: [{ at: 2500, name: 'Skill', skill: 'wrap', ms: 5 }] }),
    )
    const lines = buildReport(rows, { now: T0 }).split('\n')
    expect(lines).toContain('| Task type at submit | Scored runs | Finished under slow (target 80%) | Typical miss | Correction in use | As shown live |')
    // one row: every run is freeform at submit, matched against the runs that stayed freeform; from the tenth run on
    // there are five of those behind it, and the 26 wrap runs among the 51 scored blow through their figure
    const accuracy = lines.slice(lines.indexOf('## Accuracy per task type'), lines.indexOf('## Versus naive baselines'))
    expect(accuracy.filter(l => l.startsWith('| freeform | 51 | 49% ')).length).toBe(1)
    expect(accuracy.some(l => l.startsWith('| wrap | '))).toBe(false)
    const hit = (label: string) => Number(/\| (\d+)% \(/.exec(accuracy.find(l => l.startsWith(`| ${label} | `)) ?? '')?.[1] ?? NaN)
    expect(hit('At submit (the labels known then)')).toBe(49)
    // with each run's own label, wrap is matched to wrap: every run holds
    expect(hit("Once the labels are known (each run's own task type and project)")).toBe(100)
    expect(accuracy.some(l => l.startsWith('The second row is better informed than any estimate at submit'))).toBe(true)
  })

  test('accuracy says how the slow figures from a few matches held, and why they run optimistic', () => {
    // one type of steady runs: the 5th to 9th have 5 to 9 runs behind them, too few to give a rate
    const one = buildReport(Array.from({ length: 60 }, (_, i) => row(`m${i}`, T0 - 60 * HOUR + i * HOUR, 100)), { now: T0 })
    expect(one).toContain(
      '5 of the 55 runs scored at submit had fewer than 10 matching runs behind their slow figure. The 80th percentile of a few past runs holds only about three times in four even when they are the right runs, so the slow figure for a new or rare kind of task is optimistic.',
    )
    // eight types of twelve: forty with a few matches, enough for a rate
    const eight = buildReport(Array.from({ length: 96 }, (_, i) => row(`t${i}`, T0 - 100 * HOUR + i * HOUR, 100, { taskType: `type-${i % 8}` })), { now: T0 })
    expect(eight).toContain('40 of the 56 runs scored at submit had fewer than 10 matching runs behind their slow figure, and finished under it 100% (91% to 100%). ')
  })

  test('the cost table scores the same replay on dollars', () => {
    // each wrap run cost $1 but the last, which cost $1.50 with its subagent: five of six held
    has('| all types | 6 | too few to say | x1.0 |')
    has('| wrap | 6 | too few to say | x1.0 |')
  })

  test('an empty log still makes a note', () => {
    const empty = buildReport([], { now: T0 })
    expect(empty).toContain('type: reference')
    expect(empty).toContain('No runs are logged yet.')
  })

  test('more than twenty task types: the rest fold into other', () => {
    const rows = Array.from({ length: 25 }, (_, i) => row(`x${i}`, T0 - i * HOUR, 10, { taskType: `type-${i}` }))
    const big = buildReport(rows, { now: T0 })
    expect(big).toContain('| other (5 types) | 5 |')
    expect(big.split('\n').filter(l => l.startsWith('| type-')).length).toBe(20)
  })
})
