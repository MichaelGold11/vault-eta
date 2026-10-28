import { describe, expect, test } from 'claude-code/testing'

import { canImport, findTranscripts, importHistory, projectsRoot } from '../lib/coldstart.mjs'
import { main, meta, sub } from './fixtures/backfill'

// /eta backfill's import over a file system in memory: the transcripts under
// the projects folder, the vault with and without a live log, and the write
// rule (no symbolic link, only its own backfill files replaced).

const ROOT = '/home/x/.claude/projects'
const DIR = `${ROOT}/-v`
const RUNS = '/v/.vault-eta/runs/mbeef0001'

type Mem = { files: Map<string, string>; links: Map<string, string>; tooBig: Set<string> }

function memory(setup: { files?: Record<string, string>; links?: Record<string, string>; tooBig?: string[] } = {}) {
  const mem: Mem = { files: new Map(Object.entries(setup.files ?? {})), links: new Map(Object.entries(setup.links ?? {})), tooBig: new Set(setup.tooBig ?? []) }
  for (const [name, lines] of Object.entries(main)) mem.files.set(`${DIR}/${name}`, lines.join('\n'))
  for (const [name, lines] of Object.entries(sub)) mem.files.set(`${DIR}/${name}`, lines.join('\n'))
  for (const [name, value] of Object.entries(meta)) mem.files.set(`${DIR}/${name}`, JSON.stringify(value))
  const real = (p: string): string => {
    for (const [from, to] of mem.links) if (p === from || p.startsWith(`${from}/`)) return real(to + p.slice(from.length))
    return p
  }
  const dirs = () => {
    const out = new Set(['/v'])
    for (const p of [...mem.files.keys(), ...mem.links.keys()]) for (let at = p.slice(0, p.lastIndexOf('/')); at.length > 1; at = at.slice(0, at.lastIndexOf('/'))) out.add(at)
    return out
  }
  const fs = {
    list: async (path: string) => {
      const at = real(path)
      const kids = new Map<string, { name: string; kind: string; isLink: boolean }>()
      for (const p of [...mem.files.keys(), ...mem.links.keys()]) {
        if (!p.startsWith(`${at}/`) && !mem.links.has(p)) continue
        const link = mem.links.has(p)
        const base = link ? path : at
        const from = link ? p : p
        if (!from.startsWith(`${base}/`)) continue
        const rest = from.slice(base.length + 1)
        const name = rest.split('/')[0] ?? ''
        const isEntry = !rest.includes('/')
        kids.set(name, { name, kind: link && isEntry ? 'other' : isEntry ? 'file' : 'dir', isLink: link && isEntry })
      }
      if (kids.size === 0 && !dirs().has(at)) throw new Error('ENOENT')
      return [...kids.values()]
    },
    read: async (path: string) => {
      if (mem.tooBig.has(path)) throw new Error('EFBIG')
      const text = mem.files.get(real(path))
      if (text === undefined) throw new Error('ENOENT')
      return text
    },
    write: async (path: string, text: string) => void mem.files.set(real(path), text),
    stat: async (path: string, options?: { resolve?: boolean }) => {
      const at = real(path)
      const isLink = mem.links.has(path)
      const isFile = mem.files.has(at)
      const isDir = dirs().has(at)
      if (!isFile && !isDir && !isLink) throw new Error('ENOENT')
      return { kind: isFile ? 'file' : isDir ? 'dir' : 'other', isLink, ...(options?.resolve && (isFile || isDir) ? { realPath: at } : {}) }
    },
  }
  return { mem, fs }
}

const opts = { vault: '/v', machine: 'mbeef0001', root: ROOT }

describe('cold start: the transcripts', () => {
  test('the projects folder: CLAUDE_CONFIG_DIR first, else the home folder', () => {
    expect(projectsRoot({ HOME: '/home/x' })).toBe('/home/x/.claude/projects')
    expect(projectsRoot({ USERPROFILE: 'C:\\Users\\x\\' })).toBe('C:\\Users\\x/.claude/projects')
    expect(projectsRoot({ HOME: '/home/x', CLAUDE_CONFIG_DIR: '/cfg' })).toBe('/cfg/projects')
    expect(projectsRoot({})).toBe(null)
  })

  test('found by the slug of the vault path; none when there are none', async () => {
    const { fs } = memory()
    expect((await findTranscripts(fs, '/v', ROOT))?.files).toEqual(['sess1.jsonl'])
    expect(await canImport(fs, '/v', ROOT)).toBe(true)
    expect(await canImport(fs, '/other', ROOT)).toBe(false)
    expect(await canImport(fs, '/v', null)).toBe(false)
  })
})

describe('cold start: /eta backfill', () => {
  test('imports the runs as this machine, with the ignore file, and keeps no prompt text', async () => {
    const { mem, fs } = memory()
    expect(await importHistory(fs, opts)).toBe('imported 2 runs')
    expect([...mem.files.keys()].filter(k => k.startsWith('/v/')).sort()).toEqual(['/v/.vault-eta/.gitignore', `${RUNS}/backfill-2026-10.jsonl`])
    expect(mem.files.get('/v/.vault-eta/.gitignore')).toBe('*\n')
    const written = mem.files.get(`${RUNS}/backfill-2026-10.jsonl`) ?? ''
    const rows = written.trim().split('\n').map(l => JSON.parse(l))
    expect(rows.filter(r => !r.agentId).map(r => r.runId)).toEqual(['p1', 'p2'])
    expect(rows.every(r => r.machineId === 'mbeef0001' && r.src === 'backfill')).toBe(true)
    expect(written.includes('SECRET')).toBe(false)
  })

  test('runs the live log already has are left; a second run replaces only its own files', async () => {
    const live = JSON.stringify({ kind: 'turn', runId: 'p1', agentId: null }) + '\n'
    const { mem, fs } = memory({ files: { [`${RUNS}/2026-10-10-s1.jsonl`]: live, [`${RUNS}/notes.txt`]: 'mine', [`${RUNS}/backfill-2026-09.jsonl`]: 'old\n' } })
    expect(await importHistory(fs, opts)).toBe('imported 1 run')
    expect(mem.files.get(`${RUNS}/notes.txt`)).toBe('mine')
    expect(mem.files.get(`${RUNS}/2026-10-10-s1.jsonl`)).toBe(live)
    // $.fs cannot delete: the month this run no longer has is emptied
    expect(mem.files.get(`${RUNS}/backfill-2026-09.jsonl`)).toBe('')
    expect((mem.files.get(`${RUNS}/backfill-2026-10.jsonl`) ?? '').includes('"runId":"p2"')).toBe(true)
    await importHistory(fs, opts)
    expect(mem.files.get(`${RUNS}/notes.txt`)).toBe('mine')
  })

  test('a transcript too big for $.fs is skipped and said so; no transcripts is said too', async () => {
    const { fs } = memory({ tooBig: [`${DIR}/sess1.jsonl`] })
    expect(await importHistory(fs, opts)).toMatch(/^imported 0 runs; 1 transcript skipped/)
    expect(await importHistory(fs, { ...opts, vault: '/nowhere' })).toBe('no Claude Code transcripts found for this folder')
  })

  test('a linked .vault-eta, machine folder, month file or ignore file: nothing is written through it', async () => {
    const plants: Array<[string, Record<string, string>, Record<string, string>]> = [
      ['.vault-eta', {}, { '/v/.vault-eta': '/out' }],
      ['machine', { '/v/.vault-eta/runs/other': 'x' }, { [RUNS]: '/out' }],
      ['month file', { '/out/backfill-2026-10.jsonl': 'theirs' }, { [`${RUNS}/backfill-2026-10.jsonl`]: '/out/backfill-2026-10.jsonl' }],
      ['ignore file', {}, { '/v/.vault-eta/.gitignore': '/out/nowhere' }],
    ]
    for (const [name, files, links] of plants) {
      const { mem, fs } = memory({ files, links })
      const before = [...mem.files].filter(([k]) => !k.startsWith(DIR))
      let message = ''
      await importHistory(fs, opts).catch((e: Error) => (message = e.message))
      expect(message, name).toMatch(/^nothing written: /)
      expect([...mem.files].filter(([k]) => !k.startsWith(DIR)), name).toEqual(before)
    }
  })

  test('a transcript that is a symbolic link is not read', async () => {
    const { mem, fs } = memory({ links: { [`${DIR}/sess2.jsonl`]: '/etc/secret.jsonl' }, files: { '/etc/secret.jsonl': main['sess1.jsonl']!.join('\n') } })
    expect((await findTranscripts(fs, '/v', ROOT))?.files).toEqual(['sess1.jsonl'])
    await importHistory(fs, opts)
    expect(mem.files.size).toBeGreaterThan(0)
  })

  test('a machine id that is not a folder name is refused', async () => {
    const { fs } = memory()
    await expect(importHistory(fs, { ...opts, machine: '../x' })).rejects.toThrow('this machine has no id yet')
  })
})
