import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { Recorder } from '../hooks/record'
import type { TurnRow } from '../hooks/record'
import { groupByRun, summarizeRuns } from '../lib/aggregate.mjs'

// The test's hooks stand for the engine beneath the plugin. The clock is the
// world's own, moved by the test and by the scripted model and tools, so a
// row's times can be checked to the millisecond. Ticks of the plugin's
// one-second timer are held until the test lets one through (`tick`).

const T0 = new Date(2026, 9, 18, 12, 0, 0).getTime()
const DATE = '2026-10-18'
const CWD = '/vault'
const OPUS = 'claude-opus-5-5'
const HAIKU = 'claude-haiku-5-5'

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
type Script = { firstMs: number; writeMs: number; usage: Usage | null; thinking?: string; model?: string }
type Gate = { wait: Promise<void>; open: () => void }

type World = {
  now: number
  files: Map<string, string>
  sessionId: string
  costUsd: number
  root?: string
  contextTokens: number
  nowCalls: number
  ticks: Array<() => void>
  steps: Script[]
  toolMs: Record<string, number>
  gates: Record<string, Gate>
  results: Record<string, unknown>
  asks: Set<string>
}

const usage = (input: number, cacheWrite: number, cacheRead: number, output: number): Usage => ({
  input_tokens: input,
  cache_creation_input_tokens: cacheWrite,
  cache_read_input_tokens: cacheRead,
  output_tokens: output,
})

function newWorld(): World {
  return { now: T0, files: new Map(), sessionId: 's1', costUsd: 1, contextTokens: 42_000, nowCalls: 0, ticks: [], steps: [], toolMs: {}, gates: {}, results: {}, asks: new Set() }
}

function gate(): Gate {
  let open = () => {}
  const wait = new Promise<void>(r => (open = r))
  return { wait, open }
}

function listDir(files: Map<string, string>, dir: string) {
  const prefix = dir.endsWith('/') ? dir : `${dir}/`
  const names = new Map<string, 'file' | 'dir'>()
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    const cut = rest.indexOf('/')
    names.set(cut < 0 ? rest : rest.slice(0, cut), cut < 0 ? 'file' : 'dir')
  }
  return [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false }))
}

function engine(on: On, world: World, store?: Record<string, unknown>) {
  mock.store(on, store)
  on('clock.now', () => {
    world.nowCalls += 1
    return { value: world.now }
  })
  on('clock.every', () => new Promise(resolve => world.ticks.push(() => resolve({ value: undefined }))))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.root', () => ({ value: world.root ?? CWD }))
  on('session.id', () => ({ value: world.sessionId }))
  on('session.version', () => ({ value: { version: '2.1.302' } }))
  on('session.usage', () => ({
    value: { startedAt: T0, context: { tokens: world.contextTokens, window: 1_000_000, percent: 4 }, rateLimits: [], cost: { usd: world.costUsd } },
  }))
  on('fs.write', ($, e) => {
    world.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const text = world.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.list', ($, e) => ({ value: listDir(world.files, e.path) }))
  // no links in this world: a path is a file, a folder (the root, or one with files under it), or nothing
  on('fs.stat', ($, e) => {
    const isFile = world.files.has(e.path)
    const isDir = e.path === CWD || e.path === world.root || [...world.files.keys()].some(k => k.startsWith(`${e.path}/`))
    if (!isFile && !isDir) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: isFile ? ('file' as const) : ('dir' as const), size: 0, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: e.path } : {}) } }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.PostToolUse', () => ({}))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.check', ($, e) => ({ decision: world.asks.has(e.tool_use_id ?? '') ? ('ask' as const) : ('allow' as const) }))
  on('agent.spawn', ($, e) => ({ model: HAIKU, agentId: `agent-${e.description}` }))
  on('tool.call', async ($, e) => {
    const id = e.tool_use_id ?? ''
    const held = world.gates[id]
    if (held) await held.wait
    world.now += world.toolMs[id] ?? 100
    if (e.tool === 'Bash' && e.command.startsWith('false')) return { result: {}, text: 'exit 1', isError: true as const }
    return { result: (world.results[id] ?? {}) as never, text: 'ok' }
  })
  on('turn.step', async function* ($, e) {
    const s = world.steps.shift() ?? { firstMs: 500, writeMs: 500, usage: usage(10, 0, 0, 10) }
    world.now += s.firstMs
    if (s.thinking) yield { kind: 'thinking' as const, index: 0, text: s.thinking }
    yield { kind: 'text' as const, index: 1, text: 'ok' }
    world.now += s.writeMs
    const u = s.usage ? { ...s.usage, model: s.model ?? e.model } : null
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: u }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: u }
  })
}

/** Equal to the nano-dollar: rows round dollars to nine places. */
const near = (a: unknown, b: number) => typeof a === 'number' && Math.abs(a - b) < 1e-9

type Timers = { setTimeout: (fn: () => void, ms: number) => unknown }
const pause = (ms: number) => new Promise<void>(r => (globalThis as unknown as Timers).setTimeout(r, ms))

/** Lets the plugin finish what it does after a hook answered: the view refresh and the log writes. */
const settle = () => pause(25)

/** Lets one held tick through after `ms`, and waits until the plugin has read the clock for it. */
async function tick(world: World, ms: number) {
  for (let i = 0; i < 200 && world.ticks.length === 0; i++) await pause(2)
  world.now += ms
  const before = world.nowCalls
  const release = world.ticks.shift()
  expect(release).toBeDefined()
  release?.()
  for (let i = 0; i < 200 && world.nowCalls === before; i++) await pause(2)
  await pause(5)
}

async function start($: Engine) {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
}

async function prompt($: Engine, text: string, promptId: string, command?: string) {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, ...(command ? { command: { name: command, args: '' } } : {}) } as never)
  await $.classic.UserPromptSubmit({ prompt: text, prompt_id: promptId, permission_mode: 'acceptEdits', source: 'user' } as never)
}

async function notify($: Engine, taskId: string) {
  const text = `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n<result>the private findings</result>\n</task-notification>`
  await $.prompt.submit({ text, wait: false, origin: { kind: 'task-notification' } } as never)
  return text
}

async function drain(stream: AsyncGenerator<unknown, unknown>) {
  for (;;) {
    const n = await stream.next()
    if (n.done) return n.value
  }
}

const step = ($: Engine, turnId: string, index: number, model = OPUS, agentId?: string) =>
  drain($.turn.step({ turnId, index, model, effort: 'high', messageCount: index + 1, ...(agentId ? { agentId } : {}) } as never) as never)

async function complete($: Engine, world: World, turnId: string, startedAt: number, extra: { agentId?: string; reason?: string; usage?: Usage & { model: string } } = {}) {
  const result = await $.turn.complete({
    answer: 'done',
    durationMs: world.now - startedAt,
    isAborted: extra.reason === 'aborted',
    reason: extra.reason ?? 'answer',
    turnId,
    ...(extra.agentId ? { agentId: extra.agentId } : {}),
    ...(extra.usage ? { usage: extra.usage } : {}),
  } as never)
  await settle()
  return result
}

type Row = Record<string, any>

function logFiles(world: World) {
  return [...world.files.keys()].filter(p => p.includes('/.vault-eta/runs/')).sort()
}

function rowsOf(world: World, kind: 'turn' | 'session' = 'turn'): Row[] {
  const rows: Row[] = []
  for (const path of logFiles(world)) {
    for (const line of (world.files.get(path) ?? '').split('\n')) {
      if (line.trim() === '') continue
      const row = JSON.parse(line) as Row
      if (row.kind === kind) rows.push(row)
    }
  }
  return rows
}

describe('one run, one row per turn', () => {
  test('a run is timed, priced, classified and written; streaming timing spans the response', async ($, on) => {
    const world = newWorld()
    engine(on, world, { machineId: 'mbeef0001' })
    world.costUsd = 0 // the mod loads before the session spends anything: the baseline is zero
    await start($)
    world.costUsd = 1
    await prompt($, 'Plan the website relaunch, my secret is hunter2', 'p1')
    const t0 = world.now
    await $.turn.start({ text: 'Plan the website relaunch, my secret is hunter2', turnId: 'm1' } as never)

    // a streamed request: thinking after 1.2s, the stop chunk 3s later, 600 tokens out
    world.steps.push({ firstMs: 1200, writeMs: 3000, thinking: 'hmm', usage: usage(1000, 2000, 10_000, 600) })
    await step($, 'm1', 0)
    await $.tool.call({ tool: 'Skill', skill: 'kickoff', tool_use_id: 'k0' } as never)
    await $.tool.call({ tool: 'Skill', skill: 'website-work', tool_use_id: 'k1' } as never)
    world.toolMs.r1 = 250
    await $.tool.call({ tool: 'Read', file_path: '/vault/01-projects/website/plan/website-now.md', tool_use_id: 'r1' } as never)
    world.toolMs.b1 = 90_000
    await $.tool.call({ tool: 'Bash', command: 'cd /vault && bun run build --token sk-live-123', tool_use_id: 'b1' } as never)
    await $.tool.call({ tool: 'Edit', file_path: '/vault/01-projects/website/plan/website-now.md', old_string: 'old line', new_string: 'new line\nsecond new line', tool_use_id: 'e1' } as never)
    await $.tool.call({ tool: 'Bash', command: 'false --private-flag', tool_use_id: 'b2' } as never)
    world.steps.push({ firstMs: 400, writeMs: 1000, usage: usage(500, 0, 13_000, 200) })
    await step($, 'm1', 1)
    world.now += 50
    await complete($, world, 'm1', t0, { usage: { ...usage(1500, 2000, 23_000, 800), model: OPUS } })

    const files = logFiles(world)
    expect(files).toEqual([`/vault/.vault-eta/runs/mbeef0001/${DATE}-s1.jsonl`])
    const [row] = rowsOf(world)
    expect(row).toBeDefined()
    if (!row) return
    expect(row).toMatchObject({ v: 1, kind: 'turn', src: 'live', machineId: 'mbeef0001', sessionId: 's1', runId: 'p1', turnId: 'm1', agentId: null, model: OPUS, effort: 'high', outcome: 'finished' })
    expect(row.ms).toBe(world.now - t0)
    expect(row.end).toBe(world.now)

    // the streamed request: first token at 1.2s, 600 tokens over the 3s to the stop chunk
    expect(row.steps[0]).toMatchObject({ at: 0, ms: 4200, firstTokenMs: 1200, tokensPerSec: 200, thinkingChars: 3, stop: 'end_turn' })
    expect([row.steps[0].model, row.steps[0].effort]).toEqual([undefined, undefined]) // the row's own model and effort, said once
    // (1000*4 + 2000*8 + 10000*0.2 + 600*20) / 1e6, cache writes at the 1h default
    expect(near(row.steps[0].usd, 0.034)).toBe(true)
    expect(row.steps[1]).toMatchObject({ ms: 1400, firstTokenMs: 400, tokensPerSec: 200 })
    expect(row.tokens).toEqual({ input: 1500, output: 800, cacheRead: 23_000, cacheWrite: 2000 })
    expect(near(row.usd, (1500 * 4 + 800 * 20 + 23_000 * 0.2 + 2000 * 8) / 1e6)).toBe(true)

    // tools: names, times, first words of Bash, folders, line counts
    const tools = row.tools as Row[]
    expect(tools.map(t => t.name)).toEqual(['Skill', 'Skill', 'Read', 'Bash', 'Edit', 'Bash'])
    expect(tools[2]).toMatchObject({ ms: 250, dir: '01-projects/website/plan' })
    expect(tools[3]).toMatchObject({ ms: 90_000, cmd: 'bun run build' })
    expect(tools[4]).toMatchObject({ dir: '01-projects/website/plan', lines: [2, 1] })
    expect(tools[5]).toMatchObject({ cmd: 'false', error: true })
    expect(row.errors).toEqual({ tools: 1, steps: 0 })
    expect(row.toolMs).toBe(100 + 100 + 250 + 90_000 + 100 + 100)
    expect(row.modelMs).toBe(4200 + 1400)
    expect(row.agentMs).toBe(row.ms)

    // the task: the first skill off the ignore list, and its project
    expect(row.task).toMatchObject({ taskType: 'website-work', skill: 'website-work', project: 'website', job: null, origin: 'composer', runStart: t0 })
    expect(row.task.promptChars).toBe('Plan the website relaunch, my secret is hunter2'.length)
    expect(row.cond).toMatchObject({ contextStart: 42_000, contextTurn: 13_000, cache: 'warm', hour: 12, permissionMode: 'acceptEdits', version: '2.1.302', cwdName: 'vault' })

    // the session row: logged against the engine's own total
    const [session] = rowsOf(world, 'session')
    expect(session).toMatchObject({ kind: 'session', sessionId: 's1', turns: 1, engineUsd: 1, version: '2.1.302' })
    expect(session?.ratio).toBe(Math.round(row.usd * 1000) / 1000)

    // never kept: prompt text, file contents, Bash arguments
    const all = [...world.files.values()].join('\n')
    for (const secret of ['hunter2', 'relaunch, my', 'sk-live-123', 'second new line', 'old line', 'private-flag', '--token']) expect(all.includes(secret), secret).toBe(false)
  })

  test('the machine id is made once and kept in the store; the job tag is read at run start', async ($, on) => {
    const world = newWorld()
    engine(on, world, { job: 'relaunch' })
    await start($)
    await prompt($, 'go', 'p1')
    const t0 = world.now
    await $.turn.start({ text: 'go', turnId: 'm1' } as never)
    await step($, 'm1', 0)
    await complete($, world, 'm1', t0)
    const [first] = logFiles(world)
    expect(first).toMatch(new RegExp(`^/vault/\\.vault-eta/runs/m[0-9a-f]{8}/${DATE}-s1\\.jsonl$`))
    expect(rowsOf(world)[0]?.task.job).toBe('relaunch')
    const id = first?.split('/')[4]

    // a second session in the same folder keeps the same machine id
    world.sessionId = 's2'
    await start($)
    await prompt($, 'again', 'p2')
    const t1 = world.now
    await $.turn.start({ text: 'again', turnId: 'm2' } as never)
    await step($, 'm2', 0)
    await complete($, world, 'm2', t1)
    expect(logFiles(world)).toEqual([`/vault/.vault-eta/runs/${id}/${DATE}-s1.jsonl`, `/vault/.vault-eta/runs/${id}/${DATE}-s2.jsonl`])
  })
})

describe('run attribution', () => {
  test('parallel subagents and a nested one join the run; their time counts once', async ($, on) => {
    const world = newWorld()
    engine(on, world, { machineId: 'mbeef0001' })
    await start($)
    await prompt($, 'map the vault', 'p1')
    const t0 = world.now
    await $.turn.start({ text: 'map the vault', turnId: 'm1' } as never)
    await step($, 'm1', 0)

    await $.agent.spawn({ prompt: 'a', description: 'a', subagentType: 'Explore', background: false, tool_use_id: 'ta' } as never)
    await $.agent.spawn({ prompt: 'b', description: 'b', subagentType: 'Explore', background: false, tool_use_id: 'tb' } as never)
    const ta = world.now
    await $.turn.start({ text: 'a', turnId: 'xa', agentId: 'agent-a' } as never)
    world.now += 100
    const tb = world.now
    await $.turn.start({ text: 'b', turnId: 'xb', agentId: 'agent-b' } as never)
    world.steps.push({ firstMs: 300, writeMs: 700, usage: usage(100, 0, 0, 100) }, { firstMs: 300, writeMs: 700, usage: usage(100, 0, 0, 100) })
    await step($, 'xa', 0, HAIKU, 'agent-a')
    await step($, 'xb', 0, HAIKU, 'agent-b')
    await $.tool.call({ tool: 'Grep', pattern: 'x', path: '/vault/01-projects/acme', tool_use_id: 'g1', agentId: 'agent-b' } as never)

    // agent a spawns its own helper: it walks up to the same run
    await $.agent.spawn({ prompt: 'c', description: 'c', subagentType: 'general-purpose', background: false, parentAgentId: 'agent-a', tool_use_id: 'tc' } as never)
    const tc = world.now
    await $.turn.start({ text: 'c', turnId: 'xc', agentId: 'agent-c' } as never)
    await step($, 'xc', 0, HAIKU, 'agent-c')
    await complete($, world, 'xc', tc, { agentId: 'agent-c', usage: { ...usage(10, 0, 0, 10), model: HAIKU } })
    await complete($, world, 'xb', tb, { agentId: 'agent-b', usage: { ...usage(100, 0, 0, 100), model: HAIKU } })
    world.now += 400
    await complete($, world, 'xa', ta, { agentId: 'agent-a', usage: { ...usage(100, 0, 0, 100), model: HAIKU } })
    expect(logFiles(world)).toEqual([]) // nothing written until the run's main turn ends

    await step($, 'm1', 1)
    await complete($, world, 'm1', t0)
    const rows = rowsOf(world)
    expect(rows.map(r => [r.agentId, r.runId, r.agentType, r.parentAgentId])).toEqual([
      ['agent-c', 'p1', 'general-purpose', 'agent-a'],
      ['agent-b', 'p1', 'Explore', null],
      ['agent-a', 'p1', 'Explore', null],
      [null, 'p1', null, null],
    ])
    expect(rows[1]).toMatchObject({ model: HAIKU, background: false })
    expect(near(rows[1]?.usd, (100 * 0.1 + 100 * 0.5) / 1e6)).toBe(true)
    expect(rows[1]?.tools[0]).toMatchObject({ name: 'Grep', dir: '01-projects/acme' })

    const [run] = groupByRun(rows as never)
    expect(run?.turns).toBe(4)
    expect(run?.agentMs).toBe(world.now - t0) // every subagent ran inside the main turn
    expect(run?.subagents.length).toBe(3)
  })

  test('a late background agent stays with its run; a task notification rejoins it and opens none', async ($, on) => {
    const world = newWorld()
    engine(on, world, { machineId: 'mbeef0001' })
    await start($)

    // run 1 starts a background agent and a background command, and ends
    await prompt($, 'research this in the background', 'p1')
    const t1 = world.now
    await $.turn.start({ text: 'research', turnId: 'm1' } as never)
    await step($, 'm1', 0)
    await $.agent.spawn({ prompt: 'dig', description: 'bg', subagentType: 'general-purpose', background: true, tool_use_id: 'tbg' } as never)
    const tbg = world.now
    await $.turn.start({ text: 'dig', turnId: 'xbg', agentId: 'agent-bg' } as never)
    world.results.sh1 = { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'shell-7' }
    await $.tool.call({ tool: 'Bash', command: 'bun test', run_in_background: true, tool_use_id: 'sh1' } as never)
    await complete($, world, 'm1', t1)
    expect(rowsOf(world).length).toBe(1)

    // run 2 is a new prompt; the background agent finishes during it
    world.now += 60_000
    await prompt($, 'something else', 'p2')
    const t2 = world.now
    await $.turn.start({ text: 'something else', turnId: 'm2' } as never)
    await step($, 'xbg', 0, HAIKU, 'agent-bg')
    await complete($, world, 'xbg', tbg, { agentId: 'agent-bg', usage: { ...usage(100, 0, 0, 100), model: HAIKU } })
    await step($, 'm2', 0)
    await complete($, world, 'm2', t2)

    // the notifications: each joins the run that started its task
    const text = await notify($, 'agent-bg')
    const t3 = world.now
    await $.turn.start({ text, turnId: 'm3' } as never)
    await step($, 'm3', 0)
    await complete($, world, 'm3', t3)
    const text2 = await notify($, 'shell-7')
    const t4 = world.now
    await $.turn.start({ text: text2, turnId: 'm4' } as never)
    await step($, 'm4', 0)
    await complete($, world, 'm4', t4)

    const rows = rowsOf(world)
    expect(rows.map(r => [r.turnId, r.agentId, r.runId])).toEqual([
      ['m1', null, 'p1'],
      ['xbg', 'agent-bg', 'p1'],
      ['m2', null, 'p2'],
      ['m3', null, 'p1'],
      ['m4', null, 'p1'],
    ])
    expect(rows[1]).toMatchObject({ background: true, agentType: 'general-purpose' })
    expect(rows[0]?.tools[0]).toMatchObject({ name: 'Bash', cmd: 'bun test', background: true })
    expect(new Set(rows.map(r => r.runId)).size).toBe(2)
    expect(JSON.stringify(rows).includes('private findings')).toBe(false)
    const runs = groupByRun(rows as never)
    expect(runs.map(r => [r.runId, r.turns])).toEqual([
      ['p1', 4],
      ['p2', 1],
    ])
  })
})

describe('outcomes and where the time went', () => {
  test('an aborted turn: no usage from the engine, the requests priced, the running tool cut', async ($, on) => {
    const world = newWorld()
    engine(on, world, { machineId: 'mbeef0001' })
    await start($)
    await prompt($, 'long job', 'p1')
    const t0 = world.now
    await $.turn.start({ text: 'long job', turnId: 'm1' } as never)
    world.steps.push({ firstMs: 500, writeMs: 500, usage: usage(1000, 0, 0, 1000) })
    await step($, 'm1', 0)
    world.gates.w1 = gate()
    const call = $.tool.call({ tool: 'Bash', command: 'bun run build', tool_use_id: 'w1' } as never)
    await pause(10)
    world.now += 7000
    await complete($, world, 'm1', t0, { reason: 'aborted' })
    world.gates.w1.open()
    await call

    const [row] = rowsOf(world)
    expect(row).toMatchObject({ outcome: 'aborted', tokens: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 } })
    expect(near(row?.usd, (1000 * 4 + 1000 * 20) / 1e6)).toBe(true)
    expect(row?.tools[0]).toMatchObject({ name: 'Bash', cut: true, ms: 7000 })
  })

  test('an asked call and a question: waiting on you is not agent time', async ($, on) => {
    const world = newWorld()
    engine(on, world, { machineId: 'mbeef0001' })
    await start($)
    await prompt($, 'ship it', 'p1')
    const t0 = world.now
    await $.turn.start({ text: 'ship it', turnId: 'm1' } as never)
    await step($, 'm1', 0)

    // the call waits 30s on a permission prompt, then runs 2s
    world.gates.a1 = gate()
    world.toolMs.a1 = 2000
    // The engine's own check of the call says allow (a test has no one to ask, so an ask there is a deny);
    // the ask the plugin sees is the test's own tool.check, raised once the call runs.
    const call = $.tool.call({ tool: 'Bash', command: 'git fetch origin main', tool_use_id: 'a1' } as never)
    await pause(5)
    world.asks.add('a1')
    await $.tool.check({ tool: 'Bash', input: { command: 'git fetch origin main' }, tool_use_id: 'a1' } as never)
    await pause(10)
    world.now += 30_000
    await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'a1', duration_ms: 2000 } as never)
    world.gates.a1.open()
    await call

    // a question the person takes 45s to answer
    world.toolMs.q1 = 45_000
    await $.tool.call({ tool: 'AskUserQuestion', questions: [], tool_use_id: 'q1' } as never)
    await step($, 'm1', 1)
    await complete($, world, 'm1', t0)

    const [row] = rowsOf(world)
    const tools = row?.tools as Row[]
    expect(tools[1]).toMatchObject({ name: 'AskUserQuestion', ms: 45_000, waitMs: 45_000, asked: true })
    expect(row?.ms).toBe(world.now - t0)
    expect(row?.waitMs).toBe((tools[0]?.waitMs ?? 0) + 45_000)
    expect(row?.agentMs).toBe((row?.ms ?? 0) - (row?.waitMs ?? 0))
    expect(tools[0]).toMatchObject({ name: 'Bash', cmd: 'git fetch', runMs: 2000, ms: 32_000 })
  })

  test('a sleep gap in the one-second tick is machine time, not agent time', async ($, on) => {
    const world = newWorld()
    engine(on, world, { machineId: 'mbeef0001' })
    await start($)
    await prompt($, 'overnight', 'p1')
    const t0 = world.now
    await $.turn.start({ text: 'overnight', turnId: 'm1' } as never)
    await tick(world, 1000)
    await tick(world, 1000)
    await tick(world, 600_000) // the lid closed for ten minutes
    await tick(world, 1000)
    await step($, 'm1', 0)
    await complete($, world, 'm1', t0)

    const [row] = rowsOf(world)
    expect(row?.ms).toBe(604_000)
    expect(row?.sleepMs).toBe(599_000)
    expect(row?.sleeps).toEqual([[3000, 599_000]])
    expect(row?.agentMs).toBe(5000)
  })
})

describe('the run clock: the band and the log agree', () => {
  const S = 1000
  const fresh = () => {
    const rec = new Recorder({ cacheWriteTtl: '1h', ignoreSkills: [], tickMs: 1000, sleepGapMs: 5000 })
    rec.startSession({ machineId: 'm1', sessionId: 's1', cwd: '/vault', version: null, now: T0 })
    return rec
  }

  test('main 20 s, a background agent 580 s, a notification turn 10 s: the band counts the agent, and the log says the same', () => {
    const rec = fresh()
    const rows: TurnRow[] = []
    rec.promptSubmitted({ origin: 'composer', isMidTurn: false, text: 'research this' })
    rec.mainTurnStarted({ turnId: 'm1', text: 'research this', now: T0 })
    const first = rec.beginStep({ turnId: 'm1', index: 0, model: OPUS, now: T0 })
    rec.endStep(first, { now: T0 + 5 * S, usage: null, stop: 'tool_use' })
    // the Agent call returns in 2 s with its agent working in the background
    rec.toolStarted({ id: 'ag', tool: 'Agent', input: { subagent_type: 'worker-sonnet', run_in_background: true }, now: T0 + 5 * S })
    rec.spawned({ agentId: 'a1', type: 'worker-sonnet', model: HAIKU, background: true })
    rec.agentTurnStarted({ agentId: 'a1', turnId: 'x1', now: T0 + 6 * S })
    rec.toolEnded({ id: 'ag', now: T0 + 7 * S, failed: false, backgroundTaskId: 'a1' })
    const last = rec.beginStep({ turnId: 'm1', index: 1, model: OPUS, now: T0 + 7 * S })
    rec.endStep(last, { now: T0 + 20 * S, usage: null, stop: 'end_turn' })
    rows.push(rec.turnCompleted({ turnId: 'm1', durationMs: 20 * S, reason: 'answer', now: T0 + 20 * S }))
    expect(rows[0]?.agentMs).toBe(20 * S)

    // the main loop is done and the agent works on: the run is still working, its clock still going
    expect(rec.liveView(T0 + 300 * S)).toMatchObject({ isWorking: true, isMainOpen: false, agentMs: 300 * S })
    rows.push(rec.turnCompleted({ agentId: 'a1', turnId: 'x1', durationMs: 580 * S, reason: 'answer', now: T0 + 586 * S }))
    expect(rec.liveView(T0 + 588 * S)).toMatchObject({ isWorking: false, agentMs: 586 * S })

    // the notification turn 2 s later; the 2 s between are no one's
    rec.promptSubmitted({ origin: 'task-notification', isMidTurn: false, text: '<task-notification>\n<task-id>a1</task-id>\n</task-notification>' })
    rec.mainTurnStarted({ turnId: 'm2', text: '<task-notification>', now: T0 + 588 * S })
    expect(rec.liveView(T0 + 593 * S)?.agentMs).toBe(591 * S)
    rows.push(rec.turnCompleted({ turnId: 'm2', durationMs: 10 * S, reason: 'answer', now: T0 + 598 * S }))

    // 0 to 586 s and 588 to 598 s: what the band shows at the end is what the log keeps
    const band = rec.liveView(T0 + 598 * S)?.agentMs
    expect(band).toBe(596 * S)
    expect(new Set(rows.map(r => r.runId)).size).toBe(1)
    expect(summarizeRuns(rows as never)[0]).toMatchObject({ agentMs: band, mainMs: 30 * S, fellBack: 0 })
  })

  test('a turn whose engine time leaves out a permission prompt starts where its loop opened: the wait inside it, both clocks 10 s', () => {
    const rec = fresh()
    rec.promptSubmitted({ origin: 'composer', isMidTurn: false, text: 'ship it' })
    rec.mainTurnStarted({ turnId: 'm1', text: 'ship it', now: T0 })
    const step1 = rec.beginStep({ turnId: 'm1', index: 0, model: OPUS, now: T0 })
    rec.endStep(step1, { now: T0 + 2 * S, usage: null, stop: 'tool_use' })
    // a dialog holds the call 30 s, then it runs 2 s
    rec.toolStarted({ id: 'b1', tool: 'Bash', input: { command: 'git push' }, now: T0 + 2 * S })
    rec.checked('b1', 'ask')
    rec.dialogShown({ tool: 'Bash' })
    expect(rec.liveView(T0 + 20 * S)).toMatchObject({ isWaitingOnYou: true, agentMs: 2 * S })
    rec.toolRan('b1', 2 * S)
    rec.toolEnded({ id: 'b1', now: T0 + 34 * S, failed: false })
    const step2 = rec.beginStep({ turnId: 'm1', index: 1, model: OPUS, now: T0 + 34 * S })
    rec.endStep(step2, { now: T0 + 40 * S, usage: null, stop: 'end_turn' })
    expect(rec.liveView(T0 + 40 * S)?.agentMs).toBe(10 * S)
    // the engine's turn time is 10 s: it left the 30 s wait out itself
    const row = rec.turnCompleted({ turnId: 'm1', durationMs: 10 * S, reason: 'answer', now: T0 + 40 * S })
    expect(row).toMatchObject({ start: T0, end: T0 + 40 * S, ms: 10 * S, waitMs: 30 * S, agentMs: 10 * S })
    expect(row.tools[0]).toMatchObject({ at: 2 * S, waitMs: 30 * S })
    expect(rec.liveView(T0 + 40 * S)?.agentMs).toBe(10 * S)
    expect(summarizeRuns([row] as never)[0]).toMatchObject({ agentMs: 10 * S, fellBack: 0 })
  })
})

describe('conditions', () => {
  test('a compaction, a subagent run under its own mode, a cold cache and a failed tool', async ($, on) => {
    const world = newWorld()
    engine(on, world, { machineId: 'mbeef0001' })
    const kept = [{ role: 'user' as const, text: 'summary', toolUses: [] }]
    on('session.compact', ($, e) => (e.trigger === 'precompute' ? { messages: kept } : { messages: kept, tokensBefore: 180_000, tokensAfter: 30_000 }))
    on('classic.PostToolUseFailure', () => ({}))
    await start($)
    await prompt($, 'big job', 'p1')
    const t0 = world.now
    await $.turn.start({ text: 'big job', turnId: 'm1' } as never)
    world.steps.push({ firstMs: 100, writeMs: 100, usage: usage(500, 40_000, 1000, 10) })
    await step($, 'm1', 0)
    await $.session.compact({ trigger: 'precompute', messages: kept } as never)
    await $.session.compact({ trigger: 'auto', messages: kept } as never)
    await $.agent.spawn({ prompt: 'p', description: 'plan', subagentType: 'Plan', background: false, permissionMode: 'plan', tool_use_id: 'tp' } as never)
    const ta = world.now
    await $.turn.start({ text: 'p', turnId: 'xp', agentId: 'agent-plan' } as never)
    world.toolMs.f1 = 3000
    await $.tool.call({ tool: 'Bash', command: 'false', tool_use_id: 'f1', agentId: 'agent-plan' } as never)
    await $.classic.PostToolUseFailure({ tool_name: 'Bash', tool_input: {}, tool_use_id: 'f1', error: 'exit 1', duration_ms: 2900 } as never)
    await complete($, world, 'xp', ta, { agentId: 'agent-plan' })
    await complete($, world, 'm1', t0)

    const [sub, main] = rowsOf(world)
    expect(main?.cond).toMatchObject({ cache: 'cold', contextTurn: 41_500, compactions: [{ trigger: 'auto', before: 180_000, after: 30_000 }] })
    expect(sub?.cond.permissionMode).toBe('plan')
    expect(sub?.cond.compactions).toBeUndefined()
    expect(sub?.tools[0]).toMatchObject({ name: 'Bash', error: true, runMs: 2900, ms: 3000 })
    expect(sub?.errors).toEqual({ tools: 1, steps: 0 })
    expect(main?.cond.permissionMode).toBe('acceptEdits')
  })
})

describe('the log file', () => {
  test('a log already on disk for this session is read back and rewritten whole', async ($, on) => {
    const world = newWorld()
    const path = `/vault/.vault-eta/runs/mbeef0001/${DATE}-s1.jsonl`
    const old = { v: 1, kind: 'turn', src: 'live', runId: 'p0', turnId: 'm0', agentId: null, start: T0 - 9000, end: T0 - 5000, usd: 0.5 }
    world.files.set(path, `${JSON.stringify(old)}\n{"kind":"session","turns":1}\nnot json\n`)
    engine(on, world, { machineId: 'mbeef0001' })
    await start($)
    await prompt($, 'go', 'p1')
    const t0 = world.now
    await $.turn.start({ text: 'go', turnId: 'm1' } as never)
    await step($, 'm1', 0)
    await complete($, world, 'm1', t0, { usage: { ...usage(0, 0, 0, 1000), model: OPUS } })
    expect(rowsOf(world).map(r => r.runId)).toEqual(['p0', 'p1'])
    const [session] = rowsOf(world, 'session')
    expect(session).toMatchObject({ turns: 2, loggedUsd: 0.52 })
  })

  test('a reload from a subfolder keeps the base: the same file, the rows read back', async ($, on) => {
    const world = newWorld()
    const path = `/vault/.vault-eta/runs/mbeef0001/${DATE}-s1.jsonl`
    const old = { v: 1, kind: 'turn', src: 'live', runId: 'p0', turnId: 'm0', agentId: null, start: T0 - 9000, end: T0 - 5000, usd: 0.5 }
    world.files.set(path, `${JSON.stringify(old)}\n`)
    engine(on, world, { machineId: 'mbeef0001' })
    // the shell wandered into the vault's own log folder; the session root did not move
    await $.session.start({ cwd: '/vault/.vault-eta/runs/mbeef0001', surface: 'terminal', isInteractive: true })
    await prompt($, 'go', 'p1')
    const t0 = world.now
    await $.turn.start({ text: 'go', turnId: 'm1' } as never)
    await step($, 'm1', 0)
    await complete($, world, 'm1', t0, { usage: { ...usage(0, 0, 0, 1000), model: OPUS } })
    expect(logFiles(world)).toEqual([path])
    expect(rowsOf(world).map(r => r.runId)).toEqual(['p0', 'p1'])
  })

  test('the session ratio compares what was logged after the baseline with the engine cost after it', async ($, on) => {
    const world = newWorld()
    world.costUsd = 10 // spent before the mod loaded
    engine(on, world, { machineId: 'mbeef0001' })
    await start($)
    await prompt($, 'go', 'p1')
    const t0 = world.now
    await $.turn.start({ text: 'go', turnId: 'm1' } as never)
    await step($, 'm1', 0)
    world.costUsd = 10.02
    await complete($, world, 'm1', t0, { usage: { ...usage(0, 0, 0, 1000), model: OPUS } })
    const [session] = rowsOf(world, 'session')
    expect(session).toMatchObject({ engineUsd: 10.02, engineBaseUsd: 10, loggedBaseUsd: 0, loggedUsd: 0.02, ratio: 1 })
  })

  test('after /clear the new session id gets a file of its own', async ($, on) => {
    const world = newWorld()
    engine(on, world, { machineId: 'mbeef0001' })
    await start($)
    await prompt($, 'one', 'p1')
    let t = world.now
    await $.turn.start({ text: 'one', turnId: 'm1' } as never)
    await complete($, world, 'm1', t)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as never)
    world.sessionId = 's2'
    await prompt($, 'two', 'p2')
    t = world.now
    await $.turn.start({ text: 'two', turnId: 'm2' } as never)
    await complete($, world, 'm2', t)
    expect(logFiles(world)).toEqual([`/vault/.vault-eta/runs/mbeef0001/${DATE}-s1.jsonl`, `/vault/.vault-eta/runs/mbeef0001/${DATE}-s2.jsonl`])
    expect(rowsOf(world).map(r => [r.sessionId, r.runId])).toEqual([
      ['s1', 'p1'],
      ['s2', 'p2'],
    ])
  })
})
