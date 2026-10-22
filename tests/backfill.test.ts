import { describe, expect, test } from 'claude-code/testing'

import { earlyFacts, groupByRun } from '../lib/aggregate.mjs'
import { backfill, isWindowsPath, summarize, transcriptsSlug, validMachine, vaultPath, writeOut } from '../scripts/backfill-core.mjs'
import { main, meta, sub } from './fixtures/backfill'

const IGNORE = ['kickoff', 'triage', 'checklist']
const near = (a: number | null | undefined, b: number) => typeof a === 'number' && Math.abs(a - b) < 1e-9

type Row = Record<string, any>

/** The transcripts from memory, and the run ids the live recorder already has. */
const memoryIo = (live: string[] = []) => ({
  mainFiles: () => Object.keys(main),
  subFiles: (sessionId: string) =>
    Object.keys(sub).filter(k => k.startsWith(`${sessionId}/subagents/`)).map(k => k.slice(`${sessionId}/subagents/`.length)),
  lines: async function* (file: string) {
    for (const l of main[file] ?? sub[file] ?? []) yield l
  },
  meta: (file: string) => meta[file] ?? null,
  liveRunIds: () => new Set(live),
})
const run = (over: Record<string, unknown> = {}, live: string[] = []) =>
  backfill({ machine: 'mt', dryRun: true, ignore: IGNORE, vault: 'C:\\Users\\sam\\OneDrive\\notes', ...over }, memoryIo(live))

describe('backfill from transcripts', () => {
  test('one run per human prompt; a notification and /clear open none', async () => {
    const res = await run()
    expect(res.stat.humanPrompts).toBe(2)
    const mainRows = res.kept.filter((r: Row) => !r.agentId)
    expect(mainRows.map((r: Row) => r.runId)).toEqual(['p1', 'p2'])
    expect(mainRows.every((r: Row) => r.src === 'backfill' && r.kind === 'turn' && r.machineId === 'mt')).toBe(true)
  })

  test('usage once per requestId, real 1h/5m split, unknown models unpriced', async () => {
    const res = await run()
    const p1 = res.kept.find((r: Row) => r.runId === 'p1' && !r.agentId)
    expect(p1.steps.length).toBe(4)
    // req_1: 10 in, 40 out (the larger of its two lines), 400 5m + 600 1h cache writes; claude-opus-5-5 is $4 / $20 / $5 / $8 per M
    expect(near(p1.steps[0].usd, (10 * 4 + 40 * 20 + 400 * 5 + 600 * 8) / 1e6)).toBe(true)
    expect(p1.steps[0].tokens).toEqual({ input: 10, output: 40, cacheRead: 0, cacheWrite: 1000 })
    expect(p1.tokens.output).toBe(40 + 60 + 30 + 15)
    expect(p1.steps[0].firstTokenMs).toBe(null)
    const p2 = res.kept.find((r: Row) => r.runId === 'p2')
    expect(p2.usd).toBe(null)
    expect(p2.unpriced).toBe(true)
  })

  test('durations: turn_duration lines (a notification turn joins its run), else timestamps', async () => {
    const res = await run()
    expect(res.kept.find((r: Row) => r.runId === 'p1' && !r.agentId).ms).toBe(60000 + 7000)
    expect(res.kept.find((r: Row) => r.runId === 'p2').ms).toBe(10000)
    expect(summarize(res, { dryRun: true, machine: 'mt' }).includes('top task types')).toBe(true)
  })

  test('task type from the Skill call, ignore list respected; tools keep heads and folders only', async () => {
    const res = await run()
    const p1 = res.kept.find((r: Row) => r.runId === 'p1' && !r.agentId)
    expect(p1.task.taskType).toBe('website-work')
    expect(p1.task.project).toBe('website')
    expect(p1.task.command).toBe('wrap')
    const bash = p1.tools.find((t: Row) => t.name === 'Bash')
    expect(bash.cmd).toBe('bun run build')
    expect(bash.ms).toBe(10000)
    expect(bash.error).toBe(true)
    const edit = p1.tools.find((t: Row) => t.name === 'Edit')
    expect(edit.dir).toBe('01-projects/website/plan')
    expect(edit.lines).toEqual([2, 1])
    // with the project skill ignored too, the slash command names the task
    const ignored = await run({ ignore: [...IGNORE, 'website-work'] })
    expect(ignored.kept.find((r: Row) => r.runId === 'p1' && !r.agentId).task.taskType).toBe('wrap')
  })

  test('the request numbers and shape come from the rows alone (nothing new is stored)', async () => {
    const res = await run()
    const rows = res.kept.filter((r: Row) => r.runId === 'p1')
    const early = earlyFacts(rows.filter((r: Row) => !r.agentId) as never)
    expect(early.steps).toBe(4)
    expect(early.skills).toEqual(['kickoff', 'website-work'])
    expect(early.calls.map(c => [c.name, c.step])).toEqual([['Skill', 1], ['Skill', 2], ['Agent', 2], ['Bash', 2], ['Edit', 3]])
    const [summary] = groupByRun(rows as never)
    // an Agent call inside the first two requests makes it an agents run (the Edit comes in the third)
    expect(summary?.shape).toBe('agents')
    expect(summary?.taskType).toBe('website-work')
    // the early facts hold names, folders and offsets: no text
    expect(/SECRET|--token/.test(JSON.stringify(early))).toBe(false)
  })

  test('a subagent row is linked to its run through meta.toolUseId', async () => {
    const res = await run()
    const subRow = res.kept.find((r: Row) => r.agentId === 'abc123')
    expect(subRow.runId).toBe('p1')
    expect(subRow.agentType).toBe('worker-sonnet')
    expect(subRow.model).toBe('claude-sonnet-5-5')
    expect(subRow.ms).toBe(22000)
    expect(subRow.tools[0].dir).toBe('wiki')
    expect(subRow.steps.length).toBe(2)
    expect(res.stat.orphanSubagents).toBe(0)
  })

  test('no prompt text, no full command, no Windows path in the rows', async () => {
    const res = await run()
    const text = JSON.stringify(res.kept)
    expect(/SECRET|ok thanks|one more thing|C:|OneDrive/.test(text)).toBe(false)
    expect(text.includes('--token')).toBe(false)
  })

  test('a run the live recorder logged is skipped (live wins); a re-run gives the same rows', async () => {
    const a = await run()
    const b = await run()
    expect(JSON.stringify(b.kept)).toBe(JSON.stringify(a.kept))
    const live = await run({}, ['p2'])
    expect(live.kept.some((r: Row) => r.runId === 'p2')).toBe(false)
    expect(live.kept.some((r: Row) => r.runId === 'p1')).toBe(true)
    expect(live.skipped.every((r: Row) => r.runId === 'p2')).toBe(true)
  })
})

describe('backfill works in any vault', () => {
  test('paths are cut at --vault, from any machine: the vault path, or the vault folder name on another drive', () => {
    expect(vaultPath('/Users/sam/notes/Projects/Acme/a.md', '/Users/sam/notes', '/Users/sam/notes')).toEqual({ path: '/v/Projects/Acme/a.md', cwd: '/v' })
    expect(vaultPath('C:\\Users\\sam\\notes\\wiki\\a.md', null, 'c:/users/sam/notes')).toEqual({ path: '/v/wiki/a.md', cwd: '/v' })
    // the same vault on another machine, a different parent folder
    expect(vaultPath('C:\\Users\\sam\\OneDrive\\notes\\wiki\\a.md', null, '/Users/sam/notes')).toEqual({ path: '/v/wiki/a.md', cwd: '/v' })
    // outside the vault, or no vault: untouched
    expect(vaultPath('/etc/hosts', '/x', '/Users/sam/notes')).toEqual({ path: '/etc/hosts', cwd: '/x' })
    expect(vaultPath('/Users/sam/notes/a.md', '/x', undefined)).toEqual({ path: '/Users/sam/notes/a.md', cwd: '/x' })
    expect(vaultPath('/Users/sam/notes', '/x', '/Users/sam/notes').path).toBe('/v')
  })

  test('another vault name and a PARA projects folder give the same labels', async () => {
    const res = await run({ vault: '/home/other/notes' })
    const p1 = res.kept.find((r: Row) => r.runId === 'p1' && !r.agentId)
    expect(p1.tools.find((t: Row) => t.name === 'Edit').dir).toBe('01-projects/website/plan')
    expect(p1.task.project).toBe('website')
    // a vault the transcripts do not live in leaves the folders absolute: no project from them
    const lost = await run({ vault: '/home/other/elsewhere', ignore: [...IGNORE, 'website-work'] })
    expect(lost.kept.find((r: Row) => r.runId === 'p1' && !r.agentId).task.project).toBe(null)
  })

  test('the transcripts folder is the vault path with every non-alphanumeric turned into a dash', () => {
    expect(transcriptsSlug('/Users/sam/notes')).toBe('-Users-sam-notes')
    expect(transcriptsSlug('/Users/sam/.config/my notes')).toBe('-Users-sam--config-my-notes')
    expect(transcriptsSlug('C:\\Users\\sam\\notes')).toBe('C--Users-sam-notes')
    expect(isWindowsPath('C:\\Users\\sam\\notes')).toBe(true)
    expect(isWindowsPath('d:/notes')).toBe(true)
    expect(isWindowsPath('\\\\server\\share\\notes')).toBe(true)
    expect(isWindowsPath('/Users/sam/notes')).toBe(false)
  })

  test('a machine name becomes a folder name, so only safe names pass', () => {
    expect(validMachine('laptop-2')).toBe(true)
    for (const bad of [null, '', '../x', 'a/b', 'a b', '.hidden', 'x'.repeat(41)]) expect(validMachine(bad)).toBe(false)
  })
})

describe('backfill agent time', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 11, 9, 0, 0) + s * 1000).toISOString()
  const usage = { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 100, output_tokens: 9 }
  const human = (id: string, s: number) => JSON.stringify({ promptId: id, type: 'user', message: { role: 'user', content: 'go' }, uuid: `u-${id}`, timestamp: at(s), origin: { kind: 'human' }, promptSource: 'typed', cwd: '/x/notes', sessionId: 'sw' })
  const asst = (rid: string, s: number, content: unknown[]) =>
    JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', id: `m-${rid}`, role: 'assistant', content, stop_reason: 'end_turn', usage }, requestId: rid, uuid: `a-${rid}`, timestamp: at(s), cwd: '/x/notes', sessionId: 'sw' })
  const result = (id: string, s: number) =>
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }] }, uuid: `r-${id}`, timestamp: at(s), cwd: '/x/notes', sessionId: 'sw' })
  const duration = (ms: number, s: number) => JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: ms, timestamp: at(s), uuid: `d-${s}`, sessionId: 'sw' })
  const ask = (id: string) => ({ type: 'tool_use', id, name: 'AskUserQuestion', input: {} })
  const note = (toolId: string, s: number) =>
    JSON.stringify({ promptId: 'nn', type: 'user', message: { role: 'user', content: `<task-notification><tool-use-id>${toolId}</tool-use-id></task-notification>` }, uuid: `n-${s}`, timestamp: at(s), origin: { kind: 'task-notification' }, cwd: '/x/notes', sessionId: 'sw' })

  const files: Record<string, string[]> = {
    'sw.jsonl': [
      // turn_duration leaves the 10-minute answer out; a notification an hour later is a follow-up turn
      human('pw', 0),
      asst('r1', 1, [ask('q1'), { type: 'tool_use', id: 'ag', name: 'Agent', input: { subagent_type: 'worker-sonnet', run_in_background: true } }]),
      result('q1', 601),
      asst('r2', 602, [{ type: 'text', text: 'ok' }]),
      duration(30000, 603),
      note('ag', 4200),
      asst('r3', 4205, [{ type: 'text', text: 'agent done' }]),
      duration(5000, 4206),
      // no turn_duration: wall time, with the 100 s wait taken out
      human('pf', 5000),
      asst('r4', 5001, [ask('q2')]),
      result('q2', 5101),
      asst('r5', 5106, [{ type: 'text', text: 'ok' }]),
    ],
  }
  const io = {
    mainFiles: () => ['sw.jsonl'],
    subFiles: () => [] as string[],
    lines: async function* (f: string) {
      for (const l of files[f] ?? []) yield l
    },
    meta: () => null,
    liveRunIds: () => new Set<string>(),
  }

  test('ms is the summed turn_duration, not the span; a wait already left out of it is not taken out twice', async () => {
    const res = await backfill({ machine: 'mt', dryRun: true, ignore: IGNORE }, io)
    const pw = res.kept.find((r: Row) => r.runId === 'pw')
    expect(pw.end - pw.start).toBeGreaterThan(4000 * 1000)
    expect(pw.ms).toBe(35000)
    expect(pw.waitMs).toBe(0)
    expect(pw.agentMs).toBe(35000)
  })

  test('without a turn_duration line the wall time is cut by the waits: agentMs = ms - waitMs - sleepMs', async () => {
    const res = await backfill({ machine: 'mt', dryRun: true, ignore: IGNORE }, io)
    const pf = res.kept.find((r: Row) => r.runId === 'pf')
    expect(pf.ms).toBe(106000)
    expect(pf.waitMs).toBe(100000)
    expect(pf.agentMs).toBe(pf.ms - pf.waitMs - pf.sleepMs)
    for (const r of res.kept) expect(r.agentMs).toBe(Math.max(0, r.ms - r.waitMs - r.sleepMs))
  })
})

describe('backfill writes only inside the vault', () => {
  const months = (rows: Row[]) => ({ byMonth: new Map([['2026-10', rows as unknown[]]]) })

  /** A disk in memory with folders, files and links (path to absolute target); lstat does not follow a link, the writes do. */
  function disk(setup: { dirs?: string[]; files?: Record<string, string>; links?: Record<string, string> } = {}) {
    const dirs = new Set(['/v', ...(setup.dirs ?? [])])
    const files = new Map(Object.entries(setup.files ?? {}))
    const links = new Map(Object.entries(setup.links ?? {}))
    const follow = (p: string): string => {
      for (const [from, to] of links) if (p === from || p.startsWith(`${from}/`)) return follow(to + p.slice(from.length))
      return p
    }
    const parentsOf = (p: string) => {
      const out: string[] = []
      for (let at = p.slice(0, p.lastIndexOf('/')); at.length > 1; at = at.slice(0, at.lastIndexOf('/'))) out.push(at)
      return out
    }
    return {
      dirs,
      files,
      lstat: async (p: string) => {
        if (links.has(p)) return { isLink: true, kind: 'other' as const }
        const real = follow(p)
        if (files.has(real)) return { isLink: false, kind: 'file' as const }
        if (dirs.has(real)) return { isLink: false, kind: 'dir' as const }
        return null
      },
      realPath: async (p: string) => {
        const real = follow(p)
        return files.has(real) || dirs.has(real) ? real : null
      },
      join: (...parts: string[]) => parts.join('/'),
      mkdir: (dir: string) => {
        for (const d of [follow(dir), ...parentsOf(follow(dir))]) dirs.add(d)
      },
      list: (dir: string) => {
        const real = follow(dir)
        return [...files.keys(), ...dirs, ...links.keys()].filter(p => p.startsWith(`${real}/`) && !p.slice(real.length + 1).includes('/')).map(p => p.slice(real.length + 1))
      },
      remove: (file: string) => void files.delete(follow(file)),
      write: (file: string, text: string) => void files.set(follow(file), text),
    }
  }

  test('it writes its month files and the ignore file; a second run replaces its own files only', async () => {
    const d = disk()
    await writeOut({ vault: '/v', machine: 'laptop' }, months([{ kind: 'turn', runId: 'a', start: 1 }]), d)
    expect([...d.files.keys()].sort()).toEqual(['/v/.vault-eta/.gitignore', '/v/.vault-eta/runs/laptop/backfill-2026-10.jsonl'])
    expect(d.files.get('/v/.vault-eta/.gitignore')).toBe('*\n')
    d.files.set('/v/.vault-eta/runs/laptop/notes.txt', 'mine')
    d.files.set('/v/.vault-eta/.gitignore', '')
    await writeOut({ vault: '/v', machine: 'laptop' }, months([{ kind: 'turn', runId: 'b', start: 2 }]), d)
    expect(d.files.get('/v/.vault-eta/runs/laptop/notes.txt')).toBe('mine')
    expect(d.files.get('/v/.vault-eta/.gitignore')).toBe('')
    expect(d.files.get('/v/.vault-eta/runs/laptop/backfill-2026-10.jsonl')).toContain('"runId":"b"')
  })

  test('a linked .vault-eta, runs, machine folder, month file or ignore file: nothing written or deleted', async () => {
    const plants: Array<[string, Parameters<typeof disk>[0]]> = [
      ['.vault-eta', { dirs: ['/out'], links: { '/v/.vault-eta': '/out' } }],
      ['runs', { dirs: ['/v/.vault-eta', '/out'], links: { '/v/.vault-eta/runs': '/out' } }],
      ['machine', { dirs: ['/v/.vault-eta', '/v/.vault-eta/runs', '/out'], links: { '/v/.vault-eta/runs/laptop': '/out' } }],
      ['month file', { dirs: ['/v/.vault-eta', '/v/.vault-eta/runs', '/v/.vault-eta/runs/laptop', '/out'], files: { '/out/backfill-2026-10.jsonl': 'theirs' }, links: { '/v/.vault-eta/runs/laptop/backfill-2026-10.jsonl': '/out/backfill-2026-10.jsonl' } }],
      ['ignore file leading nowhere', { dirs: ['/v/.vault-eta', '/out'], links: { '/v/.vault-eta/.gitignore': '/out/nowhere' } }],
    ]
    for (const [name, setup] of plants) {
      const d = disk(setup)
      const before = new Map(d.files)
      const dirs = new Set(d.dirs)
      let message = ''
      await writeOut({ vault: '/v', machine: 'laptop' }, months([{ kind: 'turn', runId: 'a', start: 1 }]), d).catch((e: Error) => (message = e.message))
      expect(message, name).toMatch(/^nothing written: .* is a symbolic link$/)
      expect(d.files, name).toEqual(before)
      expect(d.dirs, name).toEqual(dirs)
    }
  })
})
