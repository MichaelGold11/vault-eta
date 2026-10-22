import type { EngineInterface } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { ROLL_BYTES, SessionLog, fileName, flushLog, loadRecent, localDate, parseBackfillName, parseFileName, parseJsonl, reloadLog } from '../hooks/log'
import { KEEP_RUNS, Recorder } from '../hooks/record'
import type { TurnRow } from '../hooks/record'

// The log's pure parts, with a file system in memory standing in for $.fs.

const T0 = new Date(2026, 9, 18, 12, 0, 0).getTime()
const DAY = 86_400_000

function memoryFs(files: Map<string, string>) {
  const fs = {
    write: async (path: string, text: string) => {
      if (new TextEncoder().encode(text).length > 4 * 1024 * 1024) throw new Error('over 4 MiB')
      files.set(path, text)
    },
    read: async (path: string) => {
      const text = files.get(path)
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
    list: async (dir: string) => {
      const prefix = `${dir}/`
      const names = new Map<string, 'file' | 'dir'>()
      for (const p of files.keys()) {
        if (!p.startsWith(prefix)) continue
        const rest = p.slice(prefix.length)
        const cut = rest.indexOf('/')
        names.set(cut < 0 ? rest : rest.slice(0, cut), cut < 0 ? 'file' : 'dir')
      }
      if (names.size === 0) throw new Error(`ENOENT: ${dir}`)
      return [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false }))
    },
  }
  return { fs } as unknown as EngineInterface
}

/** A turn row padded with tool calls to about `kb` kilobytes. */
function bigRow(i: number, kb: number): TurnRow {
  const tool = { at: 1, name: 'Read', ms: 12, dir: `01-projects/website/${'x'.repeat(40)}` }
  const per = JSON.stringify(tool).length + 1
  return {
    v: 1,
    kind: 'turn',
    src: 'live',
    machineId: 'm1',
    sessionId: 's1',
    runId: `p${i}`,
    turnId: `t${i}`,
    agentId: null,
    parentAgentId: null,
    agentType: null,
    background: null,
    model: 'claude-opus-5-5',
    effort: 'high',
    start: T0 + i * 1000,
    end: T0 + i * 1000 + 500,
    ms: 500,
    agentMs: 500,
    modelMs: 400,
    toolMs: 100,
    waitMs: 0,
    sleepMs: 0,
    outcome: 'finished',
    tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    usd: 0.25,
    steps: [],
    tools: Array.from({ length: Math.ceil((kb * 1024) / per) }, () => tool),
    errors: { tools: 0, steps: 0 },
    task: { taskType: 'freeform', skill: null, command: null, project: null, job: null, promptChars: 3, origin: 'composer', runStart: T0 },
    cond: { contextStart: null, contextTurn: null, cache: null, hour: 12, weekday: 0, tzOffsetMin: 300, permissionMode: null, version: null, cwdName: 'vault' },
  }
}

const session = { machineId: 'm1', now: T0 + DAY / 2, engineUsd: 4, version: '2.1.302' }

describe('file names', () => {
  test('a session id never carries a path into a file name', () => {
    expect(fileName('2026-10-18', '../../etc/x', 1)).toBe('2026-10-18-------etc-x.jsonl')
    expect(fileName('2026-10-18', 'a/b\\c', 2)).toBe('2026-10-18-a-b-c.part2.jsonl')
    expect(fileName('2026-10-18', 'abc-123_DEF', 1)).toBe('2026-10-18-abc-123_DEF.jsonl')
  })

  test('date, session id and part', () => {
    expect(localDate(T0)).toBe('2026-10-18')
    expect(fileName('2026-10-18', 'abc-123', 1)).toBe('2026-10-18-abc-123.jsonl')
    expect(fileName('2026-10-18', 'abc-123', 2)).toBe('2026-10-18-abc-123.part2.jsonl')
    expect(parseFileName('2026-10-18-abc-123.part2.jsonl')).toEqual({ date: '2026-10-18', sessionId: 'abc-123', part: 2 })
    expect(parseFileName('2026-10-18-abc-123.jsonl')).toEqual({ date: '2026-10-18', sessionId: 'abc-123', part: 1 })
    expect(parseFileName('notes.md')).toBe(null)
    expect(parseJsonl('{"kind":"turn","runId":"a"}\n{bad\n\n{"kind":"other"}\n').length).toBe(1)
  })
})

describe('rollover', () => {
  test('past 512 KiB the part is sealed and the rows go on in a part file, each under the rollover', async () => {
    const files = new Map<string, string>()
    const $ = memoryFs(files)
    const log = new SessionLog('/v/.vault-eta/runs/m1', '2026-10-18', 's1')
    for (let i = 0; i < 14; i++) log.add(bigRow(i, 40))
    expect(log.part).toBe(2)
    await flushLog($, log, undefined, session)
    const names = [...files.keys()].sort()
    expect(names).toEqual(['/v/.vault-eta/runs/m1/2026-10-18-s1.jsonl', '/v/.vault-eta/runs/m1/2026-10-18-s1.part2.jsonl'])
    const first = parseJsonl(files.get(names[0] ?? '') ?? '')
    const second = parseJsonl(files.get(names[1] ?? '') ?? '')
    for (const name of names) expect(new TextEncoder().encode(files.get(name) ?? '').length).toBeLessThan(ROLL_BYTES + 1)
    expect(first.every(r => r.kind === 'turn')).toBe(true)
    expect(first.length + second.length - 1).toBe(14)
    expect(second[second.length - 1]).toMatchObject({ kind: 'session', turns: 14, loggedUsd: 3.5, engineUsd: 4, ratio: 0.875 })

    // a later flush rewrites only the current part
    files.delete(names[0] ?? '')
    log.add(bigRow(14, 1))
    await flushLog($, log, undefined, session)
    expect(files.has(names[0] ?? '')).toBe(false)
    expect(parseJsonl(files.get(names[1] ?? '') ?? '').pop()).toMatchObject({ kind: 'session', turns: 15 })

    // a reload picks up the newest part to go on rewriting, and counts every part's turns
    files.set(names[0] ?? '', first.map(r => JSON.stringify(r)).join('\n'))
    const again = new SessionLog('/v/.vault-eta/runs/m1', '2026-10-18', 's1')
    await reloadLog($, again)
    expect(again.part).toBe(2)
    expect(again.rows.length).toBe(second.length)
    expect(again.totals.turns).toBe(15)
  })

  test('a run whose skill came late names its earlier rows too', async () => {
    const files = new Map<string, string>()
    const log = new SessionLog('/v/l', '2026-10-18', 's1')
    log.add(bigRow(0, 1))
    const named = { ...bigRow(0, 1).task, taskType: 'wrap' }
    await flushLog(memoryFs(files), log, runId => (runId === 'p0' ? named : undefined), session)
    expect(parseJsonl(files.get('/v/l/2026-10-18-s1.jsonl') ?? '')[0]).toMatchObject({ task: { taskType: 'wrap' } })
  })
})

describe('history', () => {
  test('the last 90 days of every machine, by the date in the file name', async () => {
    const files = new Map<string, string>()
    const line = (runId: string) => `${JSON.stringify({ kind: 'turn', runId })}\n${JSON.stringify({ kind: 'session' })}\n`
    files.set(`/v/.vault-eta/runs/mac/${localDate(T0 - 2 * DAY)}-a.jsonl`, line('recent-mac'))
    files.set(`/v/.vault-eta/runs/desktop/${localDate(T0 - 30 * DAY)}-b.part2.jsonl`, line('recent-desktop'))
    files.set(`/v/.vault-eta/runs/desktop/${localDate(T0 - 120 * DAY)}-c.jsonl`, line('old'))
    files.set('/v/.vault-eta/runs/desktop/readme.txt', 'not a log')
    const rows = await loadRecent(memoryFs(files), '/v', T0)
    expect(rows.map(r => r.runId).sort()).toEqual(['recent-desktop', 'recent-mac'])
    expect(await loadRecent(memoryFs(new Map()), '/empty', T0)).toEqual([])
  })

  test('backfill files are read with the session files: by month, then each row by its start', async () => {
    const files = new Map<string, string>()
    const row = (runId: string, start: number, src = 'backfill') => JSON.stringify({ kind: 'turn', runId, start, src })
    const dir = '/v/.vault-eta/runs/mac'
    files.set(`${dir}/backfill-2026-10.jsonl`, `${row('oct-1', T0 - 3 * DAY)}\n${row('oct-2', T0 - DAY)}\n`)
    files.set(`${dir}/backfill-2026-10.part2.jsonl`, `${row('oct-3', T0 - 2 * DAY)}\n`)
    files.set(`${dir}/backfill-2026-07.jsonl`, `${row('jul-old', T0 - 100 * DAY)}\n${row('jul-in', T0 - 89 * DAY)}\n`)
    files.set(`${dir}/backfill-2026-06.jsonl`, `${row('jun', T0 - 120 * DAY)}\n`)
    files.set(`${dir}/backfill-notes.txt`, 'not a log')
    files.set(`${dir}/${localDate(T0 - DAY)}-s9.jsonl`, `${row('oct-2', T0 - DAY, 'live')}\n`)
    const rows = await loadRecent(memoryFs(files), '/v', T0)
    expect(rows.map(r => `${r.runId}:${r.src}`).sort()).toEqual(['jul-in:backfill', 'oct-1:backfill', 'oct-2:backfill', 'oct-2:live', 'oct-3:backfill'])
    expect(parseBackfillName('backfill-2026-10.part2.jsonl')).toEqual({ month: '2026-10', part: 2 })
    expect(parseBackfillName('backfill-2026-10.jsonl')).toEqual({ month: '2026-10', part: 1 })
    expect(parseBackfillName('2026-10-18-s1.jsonl')).toBe(null)
    expect(parseFileName('backfill-2026-10.jsonl')).toBe(null)
  })
})

describe('the live view (what the band and pane will draw)', () => {
  test('elapsed less sleep, cost so far, what runs now, waiting on you', () => {
    const rec = new Recorder({ cacheWriteTtl: '1h', ignoreSkills: [], tickMs: 1000, sleepGapMs: 5000 })
    rec.startSession({ machineId: 'm1', sessionId: 's1', cwd: '/v', version: null, now: T0 })
    rec.promptSubmitted({ origin: 'composer', isMidTurn: false, text: 'go', command: 'wrap' })
    rec.mainTurnStarted({ turnId: 'm1', text: 'go', now: T0 })
    const s = rec.beginStep({ turnId: 'm1', index: 0, model: 'claude-opus-5-5', now: T0 })
    rec.endStep(s, { now: T0 + 2000, usage: { input_tokens: 0, output_tokens: 50_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, stop: 'tool_use' })
    rec.toolStarted({ id: 'a1', tool: 'Bash', input: { command: 'git push' }, now: T0 + 2000 })
    rec.checked('a1', 'ask')
    rec.tick(T0 + 3000)
    rec.tick(T0 + 63_000)
    const view = rec.liveView(T0 + 70_000)
    expect(view).toMatchObject({ runId: 's1:' + T0, isWorking: true, cost: { usd: 1, priced: 1, unpriced: 0 }, mainSteps: 1, isWaitingOnYou: true, now: { kind: 'tool', name: 'Bash', sinceMs: 68_000 } })
    expect(view?.task?.taskType).toBe('wrap')
    expect(view?.elapsedMs).toBe(70_000 - 59_000)
  })

  test('shape: unknown until the third request begins, then from the tools of the first two, never changed by later ones', () => {
    const rec = new Recorder({ cacheWriteTtl: '1h', ignoreSkills: [], tickMs: 1000, sleepGapMs: 5000 })
    rec.startSession({ machineId: 'm1', sessionId: 's1', cwd: '/v', version: null, now: T0 })
    rec.promptSubmitted({ origin: 'composer', isMidTurn: false, text: 'go' })
    rec.mainTurnStarted({ turnId: 'm1', text: 'go', now: T0 })
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    const run = (index: number, at: number, tool?: { id: string; tool: string; input: unknown }) => {
      const s = rec.beginStep({ turnId: 'm1', index, model: 'claude-opus-5-5', now: T0 + at })
      if (tool) rec.toolStarted({ ...tool, now: T0 + at + 500 })
      rec.endStep(s, { now: T0 + at + 600, usage, stop: tool ? 'tool_use' : 'end_turn' })
    }
    run(0, 0, { id: 'a', tool: 'Read', input: { file_path: '/v/wiki/x.md' } })
    expect(rec.liveView(T0 + 700)?.shape).toBe(null)
    run(1, 1000, { id: 'b', tool: 'Bash', input: { command: 'ls' } })
    // the second request has ended but the third has not begun: its tools may still be arriving
    expect(rec.liveView(T0 + 1700)?.shape).toBe(null)
    rec.beginStep({ turnId: 'm1', index: 2, model: 'claude-opus-5-5', now: T0 + 2000 })
    expect(rec.liveView(T0 + 2100)?.shape).toBe('shell')
    rec.toolStarted({ id: 'c', tool: 'Edit', input: { file_path: '/v/wiki/x.md', old_string: 'a', new_string: 'b' }, now: T0 + 2500 })
    expect(rec.liveView(T0 + 2600)?.shape).toBe('shell')
  })
})

describe('the recorder at rest', () => {
  const fresh = () => {
    const rec = new Recorder({ cacheWriteTtl: '1h', ignoreSkills: [], tickMs: 1000, sleepGapMs: 5000 })
    rec.startSession({ machineId: 'm1', sessionId: 's1', cwd: '/v', version: null, now: T0 })
    return rec
  }

  test('a /compact or a tool call with no main turn open opens no loop, so the clock stops; the compaction joins the next turn', () => {
    const rec = fresh()
    rec.compacted({ trigger: 'manual', before: 90_000, after: 20_000, now: T0 })
    expect(rec.isIdle()).toBe(true)
    rec.toolStarted({ id: 'bang', tool: 'Bash', input: { command: 'ls' }, now: T0 })
    expect(rec.isIdle()).toBe(true)
    rec.promptSubmitted({ origin: 'composer', isMidTurn: false, text: 'go' })
    rec.mainTurnStarted({ turnId: 'm1', text: 'go', now: T0 + 1000 })
    const row = rec.turnCompleted({ turnId: 'm1', durationMs: 1000, reason: 'answer', now: T0 + 2000 })
    expect(row.cond.compactions).toEqual([{ trigger: 'manual', before: 90_000, after: 20_000 }])
    expect(row.tools).toEqual([])
    expect(rec.isIdle()).toBe(true)
  })

  test('finished runs past the newest KEEP_RUNS are dropped with their agents; an open one is kept', () => {
    const rec = fresh()
    for (let i = 0; i < KEEP_RUNS + 30; i++) {
      const at = T0 + i * 10_000
      rec.promptSubmitted({ origin: 'composer', isMidTurn: false, text: `run ${i}` })
      rec.mainTurnStarted({ turnId: `m${i}`, text: `run ${i}`, now: at })
      rec.spawned({ agentId: `a${i}`, type: 'worker', model: 'claude-haiku-5-5', background: false })
      rec.agentTurnStarted({ agentId: `a${i}`, turnId: `x${i}`, now: at + 100 })
      if (i !== 3) rec.turnCompleted({ agentId: `a${i}`, turnId: `x${i}`, durationMs: 100, reason: 'answer', now: at + 200 })
      rec.turnCompleted({ turnId: `m${i}`, durationMs: 500, reason: 'answer', now: at + 500 })
    }
    // the current run, the newest KEEP_RUNS before it, and run 3, whose agent still works
    expect(rec.runs.size).toBe(KEEP_RUNS + 2)
    expect(rec.agents.size).toBe(KEEP_RUNS + 2)
    expect(rec.agents.has('a3')).toBe(true)
    expect(rec.agents.has('a4')).toBe(false)
  })
})
