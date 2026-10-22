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
    task: { taskType: 'wrap', skill: null, command: null, project: 'website', job: null, promptChars: 100, origin: 'composer', runStart: start, ...task },
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
    return row(`w${i}`, start, s, {}, { tools, ...(i === 2 ? { toolMs: 7000, waitMs: 2000 } : {}) })
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
    for (const h of ['## Totals', '## By task type', '## By shape', '## By model', '## By project', '## By job', '## Who did the work', '## Where the time went', '## Accuracy per task type', '## How to read this']) {
      expect(text).toContain(h)
    }
  })

  test('totals by window', () => {
    has('| Last 7 days | 11 | 23m 40s | $9.90 |')
    has('| Last 30 days | 12 | 25m 20s | $10.90 |')
    has('| All time | 13 | 27m 00s | $11.90 |')
  })

  test('by task type: usual is the median, slow the 80th percentile, costs include subagents', () => {
    has('| wrap | 11 | 1m 40s | 1m 40s | $1.00 | $11.50 |')
    has('| freeform | 2 | 1m 00s | 1m 18s | $0.200 | $0.400 |')
  })

  test('by model, project and job', () => {
    has('| claude-opus-5-5 | 13 | 27m 00s | $11.90 |')
    has('| website | 11 | 25m 00s | $11.50 |')
    has('| (none) | 2 | 2m 00s | $0.400 |')
    has(`| launch | 1 | 1m 30s | $0.300 | ${localDate(T0 - DAY)} | ${localDate(T0 - DAY)} |`)
  })

  test('who did the work: the main thread against each subagent type and model', () => {
    has('| main thread (opus) | 13 | 27m 00s | $11.40 |')
    has('| worker-sonnet (sonnet) | 1 | 20s | $0.500 |')
  })

  test('where the time went, and the tool heads by total time', () => {
    expect(text).toContain('| Waiting on you |')
    expect(text).toContain('| Machine asleep |')
    // the Bash head keeps its first words only and counts the tool's own 4 s
    has('| Bash bun run | 1 | 4s | 4s |')
    has('| Edit | 1 | 1s | 1s |')
  })

  test('accuracy: six scored runs, four under the slow estimate, a correction of x2', () => {
    // runs 5 to 10 are scored (the first five have no history): 100 s x4 covered, then 200 s and 400 s against a slow of 100 s
    has('| wrap | 6 | 67% | x1.0 | x2.00 | - |')
    // freeform has two runs: too few to list
    expect(text.split('\n').filter(l => l.startsWith('| freeform | ')).length).toBe(1)
  })

  test('no em dash, no prompt text, three lines on how to read it', () => {
    expect(text.includes(String.fromCharCode(0x2014))).toBe(false)
    const tail = text.split('## How to read this')[1]?.trim().split('\n') ?? []
    expect(tail.length).toBe(3)
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
