import { describe, expect, test } from 'claude-code/testing'

import { SCORECARD_MARK, buildScorecard } from '../lib/scorecard.mjs'

// The scorecard on a fixture full of names a person would not paste: task
// types, projects, jobs, skills, agents, tools, paths, machines and models.
// None of them may reach the text.

const T0 = new Date(2026, 9, 18, 12, 0, 0).getTime()
const DAY = 86_400_000
const PRIVATE = ['alphasite', 'betashop', 'gammaapp', 'deltalog', 'epsilonhealth', 'launch-plan', 'acme-secret', 'mprivate1', '/Users/', 'sam-laptop', 'fable', 'deploy-prod', 'secret-host']

type Over = Record<string, unknown>

function row(i: number, over: Over = {}) {
  const ms = (60 + (i % 7) * 20) * 1000
  const start = T0 - 40 * DAY + i * 12 * 3_600_000
  return {
    v: 1,
    kind: 'turn',
    src: 'live',
    machineId: 'mprivate1',
    sessionId: 'sam-laptop-session',
    runId: `r${i}`,
    turnId: `t${i}`,
    agentId: null,
    parentAgentId: null,
    agentType: null,
    background: null,
    model: i % 2 === 0 ? 'claude-opus-5-5' : 'claude-fable-9-9',
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
    usd: 0.5 + (i % 5) / 10,
    steps: [],
    tools: [{ at: 0, name: 'Bash', cmd: 'deploy-prod secret-host', ms: 1000 }],
    task: { taskType: i % 2 === 0 ? 'alphasite-launch-plan' : 'deltalog-notes', skill: 'epsilonhealth-skill', command: null, project: i % 3 === 0 ? 'betashop' : 'gammaapp', job: 'acme-secret', promptChars: 100, origin: 'composer', runStart: start, cwd: '/Users/sam/code/acme-secret' },
    ...over,
  }
}

const rows = Array.from({ length: 80 }, (_, i) => row(i))

describe('the scorecard', () => {
  test('has the numbers: runs and days, the shape table, cost, the verdict line and drift', () => {
    const text = buildScorecard(rows)
    expect(text.startsWith(`${SCORECARD_MARK}\n`)).toBe(true)
    expect(text).toMatch(/80 runs over 41 days \(41 with runs\); 80 finished and scored\./)
    expect(text).toContain('| Shape | Scored runs | Finished under slow | Typical miss |')
    expect(text).toMatch(/\| all runs \| \d+ \| /)
    expect(text).toContain('## Cost estimate')
    expect(text).toMatch(/\*\*(yes|no|unclear)\*\* \(/)
    // the verdict is by interval score, on time and on cost, with both scores and the resample rate
    expect(text).toMatch(/on time, out of sample, by interval score\? \*\*(yes|no|unclear)\*\* \(mean interval score \d+m \d+s against \d+m \d+s, \d+\.\d% (lower|higher), lower in \d+% of 500 resamples; \d+ runs held out\)\./)
    expect(text).toMatch(/on cost, out of sample, by interval score\? \*\*(yes|no|unclear)\*\* \(mean interval score \$[\d.]+ against \$[\d.]+, /)
    expect(text).toMatch(/Does the slow figure hold as often in every month and on every model\? \*\*(yes|no|unclear)\*\*/)
  })

  test('a coverage rate carries its Wilson interval; under 30 scored runs it says too few to say', () => {
    expect(buildScorecard(rows)).toMatch(/\| all runs \| \d+ \| \d+% \(\d+% to \d+%\) \| x\d\.\d \|/)
    const few = buildScorecard(rows.slice(0, 12))
    expect(few).toContain('too few to say')
  })

  test('no task, project, job, skill, agent, tool, path, machine or model name reaches the text', () => {
    // a subagent turn with its own private type, and a session row, too
    const withAgent = [...rows, row(5, { turnId: 'sub', agentId: 'a1', agentType: 'epsilonhealth-agent', model: 'claude-sonnet-5-5' }), { v: 1, kind: 'session', src: 'live', machineId: 'mprivate1', sessionId: 'sam-laptop-session', start: T0, end: T0, turns: 3 }]
    const text = buildScorecard(withAgent)
    for (const name of PRIVATE) expect(text.toLowerCase().includes(name.toLowerCase()), name).toBe(false)
    expect(text.includes('\u2014')).toBe(false)
  })

  test('times are on the run clock, a background subagent counted; a row that cannot be placed is counted, never named', () => {
    const text = buildScorecard(rows)
    expect(text).toContain('A run takes as long as the main loop or any of its subagents worked, parallel ones counted once, with waits on you and machine sleep left out.')
    expect(text).not.toContain('could not be placed')
    // a background agent of 30 minutes on every run turns runs of a minute or two into runs of half an hour: the scored figures follow
    const agents = rows.map((r, i) => row(i, { turnId: `sub${i}`, agentId: `a${i}`, agentType: 'epsilonhealth-agent', background: true, start: r.start + 5000, end: r.start + 1_800_000, ms: 1_795_000, agentMs: 1_795_000 }))
    const longer = buildScorecard([...rows, ...agents])
    const score = (t: string) => /mean interval score (\d+)m/.exec(t)?.[1]
    expect(Number(score(longer))).toBeGreaterThan(20)
    expect(Number(score(text))).toBeLessThan(5)
    // a live row from before the recorder kept a turn's own start, its long wait outside its window
    const cut = row(90, { agentMs: 30_000, tools: [{ at: 0, name: 'Bash', cmd: 'deploy-prod secret-host', ms: 200_000, runMs: 1000, waitMs: 199_000, asked: true }] })
    const withCut = buildScorecard([...rows, cut])
    expect(withCut).toContain('1 logged row could not be placed on that clock and counts its own stored time.')
    for (const name of PRIVATE) expect(withCut.toLowerCase().includes(name.toLowerCase()), name).toBe(false)
  })

  test('a shape value that is not one of the five is not printed', () => {
    const text = buildScorecard(rows.map((r, i) => ({ ...r, shape: i % 2 === 0 ? 'secret-host' : 'edit' })))
    expect(text.includes('secret-host')).toBe(false)
  })

  test('no runs: one line, nothing else', () => {
    expect(buildScorecard([])).toBe(`${SCORECARD_MARK}\n# vault-eta scorecard\n\nNo runs are logged yet.\n`)
  })
})
