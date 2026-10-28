import { describe, expect, test } from 'claude-code/testing'

import { isInside, writeRefusal } from '../lib/safepath.mjs'

import {
  GENERIC_HELPERS,
  ROUTER_MAX_WORK,
  SHAPE_STEPS,
  classifyRun,
  commandHead,
  folderOf,
  isNoticeText,
  isProjectsFolder,
  isPersonPrompt,
  linesChanged,
  normalizePath,
  parseList,
  projectFromPath,
  relativePath,
  shapeOf,
  taskIdOf,
} from '../lib/classify.mjs'
import { fmtSecs, fmtTok, fmtUsd, formatClock, formatCost } from '../lib/format.mjs'
import { PRICES, costOf, familyOf, normalizeModel, priceOf, tokensOf } from '../lib/price.mjs'
import { clip, lengthOf, overlapMs, subtract, union } from '../lib/spans.mjs'

const M = 1_000_000
const usage = (input: number, cacheWrite: number, cacheRead: number, output: number) => ({
  input_tokens: input,
  cache_creation_input_tokens: cacheWrite,
  cache_read_input_tokens: cacheRead,
  output_tokens: output,
})
const cents = (n: number | null) => (n === null ? null : Math.round(n * 1e6) / 1e6)

describe('price table (claude-api skill 2026-10-18; cache reads on the pricing page 2026-10-28)', () => {
  test('every current model at its published rates', () => {
    // per million, from 100K of each kind (a 100K prompt keeps Haiku 5.5 on its first card); cache writes at the 1h default
    const K = 100_000
    const per = (usd: number | null) => cents(usd === null ? null : usd * 10)
    const each = (model: string) => ({
      input: per(costOf(model, usage(K, 0, 0, 0)).usd),
      output: per(costOf(model, usage(0, 0, 0, K)).usd),
      read: per(costOf(model, usage(0, 0, K, 0)).usd),
      write1h: per(costOf(model, usage(0, K, 0, 0)).usd),
      write5m: per(costOf(model, usage(0, K, 0, 0), { cacheWriteTtl: '5m' }).usd),
    })
    expect(each('claude-fable-5-1')).toEqual({ input: 10, output: 50, read: 0.25, write1h: 20, write5m: 12.5 })
    expect(each('claude-opus-5-5')).toEqual({ input: 4, output: 20, read: 0.2, write1h: 8, write5m: 5 })
    // Sonnet 5.5 reads cache at 0.05x input, as the pricing page and Claude Code's own catalog (what /cost uses) have it
    expect(each('claude-sonnet-5-5')).toEqual({ input: 2, output: 10, read: 0.1, write1h: 4, write5m: 2.5 })
    expect(each('claude-haiku-5-5')).toEqual({ input: 0.1, output: 0.5, read: 0.01, write1h: 0.2, write5m: 0.125 })
    expect(each('claude-fable-5')).toEqual({ input: 10, output: 50, read: 1, write1h: 20, write5m: 12.5 })
    expect(each('claude-opus-5')).toEqual({ input: 5, output: 25, read: 0.5, write1h: 10, write5m: 6.25 })
    expect(each('claude-opus-4-8')).toEqual(each('claude-opus-5'))
    expect(each('claude-sonnet-5')).toEqual({ input: 2, output: 10, read: 0.2, write1h: 4, write5m: 2.5 })
    expect(each('claude-sonnet-4-6')).toEqual({ input: 3, output: 15, read: 0.3, write1h: 6, write5m: 3.75 })
    expect(each('claude-haiku-4-5')).toEqual({ input: 1, output: 5, read: 0.1, write1h: 2, write5m: 1.25 })
  })

  test('every row keeps the 1.25x and 2x cache-write multipliers', () => {
    for (const p of PRICES) {
      expect(p.cacheWrite5m).toBe(p.input * 1.25)
      expect(p.cacheWrite1h).toBe(p.input * 2)
    }
  })

  test('Haiku 5.5 bills a prompt over 100K tokens on its second rate card', () => {
    expect(cents(costOf('claude-haiku-5-5', usage(100_000, 0, 0, 0)).usd)).toBe(0.01)
    // 50k uncached + 60k read is a 110k prompt: $0.50 and $0.05 per million
    expect(cents(costOf('claude-haiku-5-5', usage(50_000, 0, 60_000, M)).usd)).toBe(cents(0.025 + 0.003 + 2.5))
  })

  test('a transcript split of cache writes is used when present', () => {
    const split = { ...usage(0, 1000, 0, 0), cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 } }
    expect(cents(costOf('claude-opus-5-5', split).usd)).toBe(cents((400 * 5 + 600 * 8) / M))
    expect(tokensOf(split)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 1000, cacheWrite5m: 400, cacheWrite1h: 600 })
    expect(tokensOf({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })
  })

  test('model ids from every spelling; an unknown model is unpriced, never guessed', () => {
    expect(normalizeModel('us.anthropic.claude-opus-5-5')).toBe('claude-opus-5-5')
    expect(normalizeModel('claude-opus-5-5[1m]')).toBe('claude-opus-5-5')
    expect(normalizeModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
    expect(normalizeModel('claude-opus-4-6@20260101')).toBe('claude-opus-4-6')
    expect(priceOf('CLAUDE-SONNET-5-5')?.input).toBe(2)
    expect(costOf('claude-opus-4-1', usage(M, 0, 0, M))).toEqual({ usd: null, unpriced: true })
    expect(costOf('gpt-5', usage(1, 0, 0, 1))).toEqual({ usd: null, unpriced: true })
    expect(costOf('claude-opus-5-5', undefined)).toEqual({ usd: 0, unpriced: false })
    expect(familyOf('claude-mythos-5-1')).toBe('fable')
    expect(familyOf('claude-haiku-5-5')).toBe('haiku')
  })
})

describe('formatting', () => {
  test('tokens, dollars, seconds and clocks', () => {
    expect(fmtTok(950)).toBe('950')
    expect(fmtTok(12_345)).toBe('12k')
    expect(fmtTok(1_500_000)).toBe('1.5M')
    expect(fmtUsd(0)).toBe('$0')
    expect(fmtUsd(0.0142)).toBe('$0.014')
    expect(fmtUsd(38.4)).toBe('$38.40')
    expect(fmtSecs(8100)).toBe('8.1s')
    expect(fmtSecs(130_000)).toBe('2m 10s')
    expect(formatCost(0.004)).toBe('<$0.01')
    expect(formatCost(0.81)).toBe('$0.81')
    expect(formatClock(220)).toBe('3:40')
  })
})

describe('spans', () => {
  test('union, overlap, clip and subtract', () => {
    expect(union([[5, 10], [0, 3], [2, 6], [20, 20]])).toEqual([[0, 10]])
    expect(lengthOf([[0, 10], [5, 15], [30, 40]])).toBe(25)
    expect(clip([[0, 10], [20, 30]], [5, 25])).toEqual([[5, 10], [20, 25]])
    expect(subtract([[0, 100]], [[10, 20], [15, 30], [90, 120]])).toEqual([[0, 10], [30, 90]])
    expect(overlapMs([[0, 50], [40, 60]], [30, 100])).toBe(30)
  })
})

describe('classify', () => {
  test('Bash keeps its first words only', () => {
    expect(commandHead('bun run build')).toBe('bun run build')
    expect(commandHead('cd /Users/m/app && bun run build 2>&1 | tail -5')).toBe('bun run build')
    expect(commandHead('git push origin main')).toBe('git push')
    // a wrapper's flag values are skipped, never taken for the command
    expect(commandHead('sudo -u postgres psql -c "select 1"')).toBe('psql')
    expect(commandHead('sudo --user=postgres psql')).toBe('psql')
    expect(commandHead('sudo --user postgres psql')).toBe('psql')
    expect(commandHead('env -u SECRET_TOKEN node app.js')).toBe('node app.js')
    expect(commandHead('sudo -E bun run build')).toBe('bun run build')
    // a bare first word with : or @ (a host, a URL, a credential) is not a command name
    expect(commandHead('admin:hunter2@db.example.com --x')).toBe('')
    expect(commandHead('user@host ls')).toBe('')
    expect(commandHead('curl -H "Authorization: Bearer x" https://api.example.com')).toBe('curl')
    expect(commandHead('psql postgres://user:pass@host/db')).toBe('psql')
    expect(commandHead('git clone https://token@github.com/x/y')).toBe('git clone')
    expect(commandHead('npm run deploy -- --token x')).toBe('npm run deploy')
    expect(commandHead('export KEY=sk-123')).toBe('export')
    expect(commandHead('git checkout my-secret-branch')).toBe('git checkout')
    expect(commandHead('cat secrets.txt')).toBe('cat')
    expect(commandHead('ssh server-box uptime')).toBe('ssh')
    expect(commandHead('gh pr create --fill')).toBe('gh pr create')
    expect(commandHead('supabase db push')).toBe('supabase db push')
    expect(commandHead('npm run deploy:prod')).toBe('npm run deploy:prod')
    expect(commandHead('bun scripts/backfill.mjs --vault .')).toBe('bun backfill.mjs')
    expect(commandHead('git -C /Users/m/repo status --short')).toBe('git status')
    expect(commandHead('git commit -m "secret plan"')).toBe('git commit')
    expect(commandHead('node scripts/find.mjs "where is the price"')).toBe('node find.mjs')
    expect(commandHead('API_KEY=sk-123 npm test')).toBe('npm test')
    expect(commandHead('curl -s https://example.com/x?token=abc')).toBe('curl')
    expect(commandHead('python3 -c "print(1)"')).toBe('python3')
    expect(commandHead('/opt/homebrew/bin/claude plugin test .')).toBe('claude plugin test')
    expect(commandHead('')).toBe('')
  })

  test('folders, never files; Windows paths read like the Mac ones', () => {
    expect(normalizePath('C:\\Users\\m\\notes\\')).toBe('c:/Users/m/notes')
    expect(relativePath('C:\\Users\\m\\notes\\01-projects\\website\\a.md', 'c:/users/m/notes')).toBe('01-projects/website/a.md')
    expect(folderOf('/v/01-projects/website/plan/now.md', false, '/v')).toBe('01-projects/website/plan')
    expect(folderOf('C:\\v\\wiki\\hot.md', false, 'C:\\v')).toBe('wiki')
    expect(folderOf('/v/a/b/c/d/e/f.md', false, '/v')).toBe('a/b/c/d')
    expect(folderOf('/v/top.md', false, '/v')).toBe('.')
    expect(folderOf('01-projects/acme', true, '/v')).toBe('01-projects/acme')
    // never a name from outside the vault, never a file's name
    expect(folderOf('/elsewhere/x/y.ts', false, '/v')).toBe('(outside)')
    expect(folderOf('/Users/alice/Documents/Medical/results.pdf', true, '/Users/alice/notes')).toBe('(outside)')
    expect(folderOf('/Users/alice/.ssh/id_rsa', false, '/Users/alice/notes')).toBe('(outside)')
    expect(folderOf('~/secrets/a.md', false, '/v')).toBe('(outside)')
    expect(folderOf('../other/a.md', false, '/v')).toBe('(outside)')
    expect(folderOf('/v/clients/acme/merger-plan.md', true, '/v')).toBe('clients/acme')
    expect(folderOf('/v/config/.env.production', true, '/v')).toBe('config')
    expect(folderOf('/v/.obsidian', true, '/v')).toBe('.obsidian')
    expect(folderOf('/v', true, '/v')).toBe('.')
  })

  test('Edit, Write and MultiEdit count lines, not content', () => {
    expect(linesChanged('Edit', { old_string: 'a\nb', new_string: 'a\nb\nc\n' })).toEqual([3, 2])
    expect(linesChanged('Write', { content: 'one\ntwo' })).toEqual([2, 0])
    expect(linesChanged('MultiEdit', { edits: [{ old_string: 'x', new_string: 'y\nz' }, { old_string: '', new_string: 'w' }] })).toEqual([3, 1])
    expect(linesChanged('Read', { file_path: '/x' })).toBeUndefined()
  })

  test('task type: first skill off the ignore list, else the command, else freeform', () => {
    const ignore = parseList('kickoff, triage,checklist')
    expect(ignore).toEqual(['kickoff', 'triage', 'checklist'])
    expect(classifyRun({ skills: ['kickoff', 'website-work', 'checklist'], ignore })).toEqual({
      taskType: 'website-work',
      skill: 'website-work',
      command: null,
      project: 'website',
    })
    expect(classifyRun({ skills: ['kickoff'], command: 'wrap', ignore }).taskType).toBe('wrap')
    expect(classifyRun({ skills: [], command: null, editedPaths: ['01-projects/acme/docs', 'wiki'], readPaths: ['01-projects/website'] })).toEqual({
      taskType: 'freeform',
      skill: null,
      command: null,
      project: 'acme',
    })
    expect(classifyRun({ readPaths: ['c:/v/archive/acme/x'] }).project).toBe(null)
    expect(projectFromPath('01-projects/README.md')).toBe(null)
  })

  test('projects folder: PARA and plain names are found, any case, number prefix ignored', () => {
    for (const folder of ['Projects', 'projects', 'PROJECTS', 'Project', '01-projects', '1 Projects', '10 Projects', '1. Projects', '02_projects']) {
      expect(isProjectsFolder(folder)).toBe(true)
      expect(projectFromPath(`${folder}/Acme/notes.md`)).toBe('acme')
      expect(projectFromPath(`${folder}/Acme`)).toBe('acme')
    }
    for (const folder of ['Resources', '2 Areas', 'my-projects', 'projects-old', 'src', '01-']) expect(isProjectsFolder(folder)).toBe(false)
    expect(projectFromPath('Areas/Projects/Acme/a.md')).toBe(null)
    expect(projectFromPath('/abs/Projects/Acme/a.md')).toBe(null)
    expect(projectFromPath('c:/Projects/Acme/a.md')).toBe(null)
    expect(projectFromPath('Projects/readme.md')).toBe(null)
    expect(classifyRun({ editedPaths: ['1 Projects/Site/home.md'] }).project).toBe('site')
  })

  test('projectsFolder option names the folder, relative to the vault, and replaces detection', () => {
    expect(projectFromPath('Work/Clients/Acme/a.md', 'Work/Clients')).toBe('acme')
    expect(projectFromPath('work/clients/Acme', 'Work\\Clients')).toBe('acme')
    expect(projectFromPath('Projects/Acme/a.md', 'Work/Clients')).toBe(null)
    expect(projectFromPath('Work/Clients/a.md', 'Work/Clients')).toBe(null)
    expect(classifyRun({ editedPaths: ['Work/Clients/Acme/x'], projectsFolder: 'Work/Clients' }).project).toBe('acme')
    expect(classifyRun({ editedPaths: ['Work/Clients/Acme/x'] }).project).toBe(null)
  })

  test('a router skill, loaded and followed by another skill before other work, does not name the run', () => {
    // kickoff, then website-work at once: kickoff only handed over
    expect(classifyRun({ skills: ['kickoff', 'website-work'], skillWork: [0, 0] })).toMatchObject({ taskType: 'website-work', skill: 'website-work', project: 'website' })
    // a chain of routers: the last names the run
    expect(classifyRun({ skills: ['a', 'b', 'c'], skillWork: [0, 0, 0] }).taskType).toBe('c')
    // other work between them: the first is real work, it names the run
    expect(classifyRun({ skills: ['kickoff', 'website-work'], skillWork: [0, 1] }).taskType).toBe('kickoff')
    // a single skill is never a router; no work counts known means no router
    expect(classifyRun({ skills: ['kickoff'], skillWork: [0] }).taskType).toBe('kickoff')
    expect(classifyRun({ skills: ['kickoff', 'website-work'] }).taskType).toBe('kickoff')
    // a helper after the skill does not make it a router
    expect(classifyRun({ skills: ['website-work', 'dataviz'], skillWork: [0, 0] }).taskType).toBe('website-work')
    // the ignore list still works beside the rule
    expect(classifyRun({ skills: ['kickoff', 'website-work'], skillWork: [0, 3], ignore: ['kickoff'] }).taskType).toBe('website-work')
    expect(ROUTER_MAX_WORK).toBe(0)
  })

  test('generic helper skills do not name a run; the ignore list still works beside them', () => {
    const ignore = ['kickoff']
    // a helper loaded first, or later, is skipped: the real task names the run
    expect(classifyRun({ skills: ['artifact-capabilities', 'wrap'], ignore }).taskType).toBe('wrap')
    expect(classifyRun({ skills: ['kickoff', 'claude-in-chrome', 'website-work'], ignore }).taskType).toBe('website-work')
    // only helpers: the slash command, else freeform
    expect(classifyRun({ skills: ['dataviz', 'plugin-authoring'], command: '/ship', ignore }).taskType).toBe('ship')
    expect(classifyRun({ skills: ['find-skills'], ignore }).taskType).toBe('freeform')
    // a plugin prefix compares by the last part
    expect(classifyRun({ skills: ['anthropic-skills:artifact-design', 'wrap'] }).taskType).toBe('wrap')
    // the caller can pass its own list, or none
    expect(classifyRun({ skills: ['dataviz'], helpers: [] }).taskType).toBe('dataviz')
    expect(classifyRun({ skills: ['wrap'], helpers: ['wrap'] }).taskType).toBe('freeform')
    // the built-in list is generic: lower case names, none from one vault
    expect(GENERIC_HELPERS.every(n => n === n.toLowerCase())).toBe(true)
    expect(GENERIC_HELPERS.some(n => n.startsWith('vault-') || n.endsWith('-work'))).toBe(false)
  })

  test('shape: the most involved kind of tool wins; no tools is an answer', () => {
    expect(SHAPE_STEPS).toBe(2)
    expect(shapeOf([])).toBe('answer')
    expect(shapeOf(['Read', 'Grep', 'Skill'])).toBe('read')
    expect(shapeOf(['Read', 'Bash'])).toBe('shell')
    expect(shapeOf(['Bash', 'Edit', 'Read'])).toBe('edit')
    expect(shapeOf(['Write'])).toBe('edit')
    expect(shapeOf(['Edit', 'Agent'])).toBe('agents')
    expect(shapeOf(['Task'])).toBe('agents')
    expect(shapeOf(new Set(['mcp__x__y']))).toBe('read')
  })

  test('prompt origins and notifications', () => {
    expect(isPersonPrompt({ kind: 'composer' })).toBe(true)
    expect(isPersonPrompt({ kind: 'task-notification' })).toBe(false)
    expect(isNoticeText('<task-notification>\n<task-id>abc</task-id>')).toBe(true)
    expect(isNoticeText('please summarize')).toBe(false)
    expect(taskIdOf('<task-notification><task-id> a1b2 </task-id><status>completed</status>')).toBe('a1b2')
    expect(taskIdOf('no id here')).toBe(null)
  })
})

describe('where the mod may write', () => {
  /** A disk in memory: folders, files and links (path to absolute target), links not followed by lstat. */
  function disk(entries: { dirs?: string[]; files?: string[]; links?: Record<string, string> }) {
    const dirs = new Set(entries.dirs ?? [])
    const files = new Set(entries.files ?? [])
    const links = new Map(Object.entries(entries.links ?? {}))
    const follow = (p: string): string => {
      for (const [from, to] of links) if (p === from || p.startsWith(`${from}/`)) return follow(to + p.slice(from.length))
      return p
    }
    return {
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
    }
  }

  test('inside the folder with no link on the way: allowed, folders not made yet included', async () => {
    const io = disk({ dirs: ['/v', '/v/.vault-eta'] })
    expect(await writeRefusal(io, '/v', '/v/.vault-eta/runs/m1/a.jsonl')).toBe(null)
    expect(await writeRefusal(io, '/v', '/v/.vault-eta/.gitignore')).toBe(null)
    // the base itself may be reached through a link (a vault in a synced folder)
    const linked = disk({ dirs: ['/real/v'], links: { '/home/v': '/real/v' } })
    expect(await writeRefusal(linked, '/home/v', '/home/v/.vault-eta/x.jsonl')).toBe(null)
  })

  test('a link at .vault-eta, runs, the machine folder or the file is refused, one leading nowhere too', async () => {
    expect(await writeRefusal(disk({ dirs: ['/v', '/elsewhere'], links: { '/v/.vault-eta': '/elsewhere' } }), '/v', '/v/.vault-eta/runs/m1/a.jsonl')).toBe('.vault-eta is a symbolic link')
    expect(await writeRefusal(disk({ dirs: ['/v', '/v/.vault-eta', '/x'], links: { '/v/.vault-eta/runs': '/x' } }), '/v', '/v/.vault-eta/runs/m1/a.jsonl')).toBe('.vault-eta/runs is a symbolic link')
    expect(await writeRefusal(disk({ dirs: ['/v', '/v/.vault-eta', '/v/.vault-eta/runs', '/x'], links: { '/v/.vault-eta/runs/m1': '/x' } }), '/v', '/v/.vault-eta/runs/m1/a.jsonl')).toBe('.vault-eta/runs/m1 is a symbolic link')
    expect(await writeRefusal(disk({ dirs: ['/v', '/v/.vault-eta'], links: { '/v/.vault-eta/.gitignore': '/home/me/.bashrc' } }), '/v', '/v/.vault-eta/.gitignore')).toBe('.vault-eta/.gitignore is a symbolic link')
  })

  test('a linked folder is allowed only when asked and only while it stays inside; never a path spelled outside', async () => {
    const io = disk({ dirs: ['/v', '/v/real', '/elsewhere'], links: { '/v/notes': '/v/real', '/v/out': '/elsewhere' } })
    expect(await writeRefusal(io, '/v', '/v/notes/r.md')).toBe('notes is a symbolic link')
    expect(await writeRefusal(io, '/v', '/v/notes/r.md', { linkedFolders: true })).toBe(null)
    expect(await writeRefusal(io, '/v', '/v/out/r.md', { linkedFolders: true })).toBe('out leads outside the folder')
    expect(await writeRefusal(io, '/v', '/other/r.md')).toBe('the path is not inside the folder')
    expect(await writeRefusal(io, '/v', '/v')).toBe('the path is not inside the folder')
    expect(await writeRefusal(disk({ dirs: ['/v', '/v/a.md'] }), '/v', '/v/a.md')).toBe('a.md is not a file')
    expect(await writeRefusal(disk({}), '/v', '/v/a.md')).toBe('the folder could not be resolved')
    expect([isInside('C:\\Users\\Me\\Notes\\a', 'c:/users/me/notes'), isInside('/v2/a', '/v')]).toEqual([true, false])
  })
})
