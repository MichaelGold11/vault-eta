// @ts-check
// The backfill's logic: Claude Code's own transcripts into vault-eta log rows,
// so the ETA has history on day one. Free of file access (the caller hands in
// an `io`), because a hooks module may not import node:fs: scripts/backfill.mjs
// is the real io and the CLI, tests/backfill.test.ts an in-memory one. It
// shares lib/ with the recorder so live and backfilled rows agree.
//
// One run per human prompt (runId = the prompt's promptId, the id the live
// recorder uses, so the two dedupe). Runs the live recorder already logged are
// not returned (live wins).
//
// Never kept: prompt text, file contents, tool output, full Bash commands.

import { classifyRun, commandHead, folderOf, linesChanged, normalizePath, relativePath, toolPath, EDIT_TOOLS } from '../lib/classify.mjs'
import { costOf, tokensOf } from '../lib/price.mjs'
import { clip, lengthOf, union as unionSpans } from '../lib/spans.mjs'
import { writeRefusal } from '../lib/safepath.mjs'
import { median } from '../lib/stats.mjs'

const WAIT_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
const NOTICE = /^\s*<(task-notification|agent-message|background-task|system-reminder|local-command-caveat|local-command-stdout|bash-input|bash-stdout|bash-stderr)\b/
const round = (/** @type {number} */ n) => Math.round(n)

/**
 * A path in the vault as one virtual root (`/v/<vault-relative path>`), so
 * folders come out alike whichever machine or drive the session ran on. The
 * vault is `--vault`: a path under it is cut at it, and a path from another
 * machine that has the vault's folder name in it (`.../OneDrive/notes/a.md`
 * for a vault called `notes`) is cut after that name. Anything else is left
 * as it is.
 * @param {string} p
 * @param {string | null | undefined} cwd
 * @param {string | null | undefined} vault
 */
export function vaultPath(p, cwd, vault) {
  const s = normalizePath(p)
  const root = normalizePath(vault ?? '')
  if (root !== '') {
    const rel = relativePath(s, root)
    if (rel !== null && rel !== '.') return { path: '/v/' + rel, cwd: '/v' }
    if (rel === '.') return { path: '/v', cwd: '/v' }
    const name = root.split('/').pop() ?? ''
    if (name !== '' && !name.includes(':')) {
      const marker = `/${name.toLowerCase()}/`
      const at = s.toLowerCase().indexOf(marker)
      if (at >= 0) return { path: '/v/' + s.slice(at + marker.length), cwd: '/v' }
    }
  }
  return { path: p, cwd }
}

/** True for `C:\\x`, `C:/x` and `\\\\server\\share` paths. */
export const isWindowsPath = (/** @type {string} */ p) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')

/** The only characters a machine name may have: it becomes a folder name under `.vault-eta/runs/`. */
export function validMachine(/** @type {unknown} */ m) {
  return typeof m === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(m)
}

/**
 * The folder name Claude Code gives a project's transcripts under
 * `~/.claude/projects/`: every character that is not a letter or digit
 * becomes a dash, so `/home/x/notes` is `-home-x-notes` and `C:\Users\x\notes`
 * is `C--Users-x-notes`.
 * @param {string} dir
 */
export function transcriptsSlug(dir) {
  return String(dir).replace(/[^a-zA-Z0-9]/g, '-')
}

/** @param {any} content */
function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter(b => b && b.type === 'text').map(b => String(b.text ?? '')).join('\n')
  return ''
}

/**
 * One tool call of an owner, as the live TurnRow keeps it, plus the working fields `_at` and `_done`.
 * @typedef {{ _at: number, name: string, ms: number, _done?: boolean, cmd?: string, dir?: string, lines?: any, skill?: string, agentType?: string, background?: boolean, error?: boolean, waitMs?: number, cut?: boolean }} Tool
 * @typedef {{ start: number, dur: number | null, last: number, line?: boolean, aborted?: boolean }} Seg
 * @typedef {{ start: number, requests: Map<string, any>, tools: Tool[], lastTs: number, prevTs: number }} Owner
 */

/**
 * The clock spans of an owner's finished waits on the person.
 * @param {Owner} owner
 */
function waitSpansOf(owner) {
  return owner.tools.filter(t => t._done && WAIT_TOOLS.has(t.name)).map(t => /** @type {[number, number]} */ ([t._at, t._at + t.ms]))
}

/**
 * The usage-bearing state of one transcript owner: a main run or a subagent.
 * @param {number} start
 * @returns {Owner}
 */
function newOwner(start) {
  return { start, requests: new Map(), tools: [], lastTs: start, prevTs: start }
}

/**
 * Reads one transcript, line by line, through the io the caller gives.
 * @param {any} io
 * @param {string} file
 * @param {(o: any) => void} onLine
 */
async function eachLine(io, file, onLine) {
  for await (const line of io.lines(file)) {
    if (line.length < 2) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    onLine(o)
  }
}

/**
 * The shared line handler for assistant and tool-result lines of one owner
 * (`owner` = a run's main loop, or a subagent).
 * @param {any} st
 * @param {Owner} owner
 * @param {any} o
 * @param {number} tsMs
 * @param {string | null | undefined} cwdRoot
 * @param {string | null | undefined} vault
 */
function noteAssistant(st, owner, o, tsMs, cwdRoot, vault) {
  const msg = o.message
  if (!msg || !Array.isArray(msg.content) && typeof msg.content !== 'string') return
  const model = msg.model
  if (!model || model === '<synthetic>') return
  const rid = o.requestId ?? msg.id ?? o.uuid
  let rq = owner.requests.get(rid)
  if (!rq) {
    rq = { model, effort: o.effort ?? o.perTurnEffort ?? null, first: tsMs, last: tsMs, prev: owner.prevTs, usage: null, out: -1, stop: null }
    owner.requests.set(rid, rq)
  }
  rq.last = Math.max(rq.last, tsMs)
  const u = msg.usage
  if (u && typeof u === 'object') {
    const out = Number(u.output_tokens) || 0
    if (out >= rq.out) { rq.out = out; rq.usage = u; rq.stop = msg.stop_reason ?? rq.stop }
  }
  if (Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (!b || b.type !== 'tool_use') continue
      const name = String(b.name ?? '')
      const input = b.input ?? {}
      /** @type {Tool} */
      const row = { _at: tsMs, name, ms: 0 }
      if (name === 'Bash' || name === 'PowerShell') row.cmd = commandHead(input.command)
      const tp = toolPath(name, input)
      if (tp) {
        const v = vaultPath(tp.path, cwdRoot, vault)
        // only a path in the vault keeps its folder; anything else is (outside)
        row.dir = folderOf(v.path, tp.isDir, v.cwd === '/v' ? '/v' : '')
        const rel = v.cwd === '/v' ? v.path.replace(/^\/v\/?/, '') : normalizePath(v.path)
        if (EDIT_TOOLS.has(name)) st.edited.push(rel)
        else if (name === 'Read') st.read.push(rel)
      }
      const lines = linesChanged(name, input)
      if (lines) row.lines = lines
      if (name === 'Skill' && typeof input.skill === 'string') { row.skill = input.skill; st.skills.push(input.skill); st.skillWork.push(st.work) } else st.work++
      if (name === 'Agent' || name === 'Task') {
        if (typeof input.subagent_type === 'string') row.agentType = input.subagent_type
        if (input.run_in_background === true || input.run_in_background === 'true') row.background = true
        st.agentUse.set(b.id, { runOwner: owner, row })
      }
      owner.tools.push(row)
      st.pending.set(b.id, { row, owner })
    }
  }
}

/**
 * @param {any} st
 * @param {any} o
 * @param {number} tsMs
 */
function noteToolResult(st, o, tsMs) {
  const c = o.message?.content
  if (!Array.isArray(c)) return false
  let any = false
  for (const b of c) {
    if (!b || b.type !== 'tool_result') continue
    any = true
    const p = st.pending.get(b.tool_use_id)
    if (!p) continue
    p.row.ms = Math.max(0, round(tsMs - p.row._at))
    p.row._done = true
    if (b.is_error === true) p.row.error = true
    st.pending.delete(b.tool_use_id)
  }
  return any
}

/**
 * Rows for an owner's requests and tools, sharing the shape of the live TurnRow.
 * @param {Owner} owner
 * @param {number} start
 * @param {number} end
 * @param {string | null} fallbackModel
 */
function build(owner, start, end, fallbackModel) {
  const reqs = [...owner.requests.values()].filter(r => r.usage).sort((a, b) => a.first - b.first)
  const rowModel = reqs[0]?.model ?? fallbackModel ?? 'unknown'
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let usd = 0
  let unpriced = false
  const steps = reqs.map(r => {
    const t = tokensOf(r.usage)
    const c = costOf(r.model, r.usage)
    tokens.input += t.input; tokens.output += t.output; tokens.cacheRead += t.cacheRead; tokens.cacheWrite += t.cacheWrite
    if (c.usd === null) unpriced = true
    else usd += c.usd
    /** @type {any} */
    const s = { at: Math.max(0, round(r.first - start)) }
    if (r.model !== rowModel) s.model = r.model
    s.ms = Math.max(0, round(r.last - Math.min(r.prev, r.first)))
    s.firstTokenMs = null
    s.tokensPerSec = null
    s.tokens = { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite }
    s.usd = c.usd === null ? null : Number(c.usd.toFixed(8))
    s.stop = r.stop
    return s
  })
  const tools = owner.tools.map(t => {
    const { _at, _done, ...rest } = t
    const out = { at: Math.max(0, round(_at - start)), ...rest }
    if (!_done) { out.cut = true; out.ms = 0 }
    if (WAIT_TOOLS.has(t.name)) out.waitMs = out.ms
    return out
  })
  const modelMs = steps.reduce((a, s) => a + s.ms, 0)
  const toolSpans = owner.tools.filter(t => t._done).map(t => /** @type {[number, number]} */ ([t._at, t._at + t.ms]))
  const waitSpans = owner.tools.filter(t => t._done && WAIT_TOOLS.has(t.name)).map(t => /** @type {[number, number]} */ ([t._at, t._at + t.ms]))
  const first = reqs[0]
  const warm = first ? (tokensOf(first.usage).cacheRead > tokensOf(first.usage).cacheWrite ? 'warm' : 'cold') : null
  return {
    model: rowModel,
    effort: reqs[0]?.effort ?? null,
    steps, tools, tokens,
    usd: unpriced ? null : Number(usd.toFixed(8)),
    unpriced: unpriced || undefined,
    modelMs: Math.min(modelMs, Math.max(0, end - start)),
    toolMs: lengthOf(toolSpans),
    waitMs: lengthOf(waitSpans),
    errors: { tools: tools.filter(t => t.error).length, steps: 0 },
    contextTurn: first ? (() => { const t = tokensOf(first.usage); return t.input + t.cacheRead + t.cacheWrite })() : null,
    cache: warm,
  }
}

/**
 * @param {any} opts
 * @param {any} io
 */
export async function backfill(opts, io) {
  const { machine } = opts
  const stat = {
    files: 0, subFiles: 0, humanPrompts: 0, durationLines: 0, durationMs: 0, dupRuns: 0, orphanSubagents: 0,
  }
  /** @type {Map<string, any>} */
  const runs = new Map()
  /** @type {any[]} */
  const subs = []
  /** @type {Map<string, string>} toolUseId -> runId (any Agent tool_use, main or sub) */
  const toolToRun = new Map()
  /** @type {Map<string, any>} toolUseId -> subagent record that issued it */
  const toolToSub = new Map()

  const mains = io.mainFiles()
  for (const f of mains) {
    const sessionId = f.slice(0, -'.jsonl'.length)
    stat.files++
    const st = { pending: new Map(), agentUse: new Map(), skills: [], skillWork: [], work: 0, edited: [], read: [] }
    /** @type {Map<string, any>} */
    const fileRuns = new Map()
    /** @type {any} */
    let cur = null // current run
    /** @type {any} */
    let seg = null // current segment {run, start, last, dur}
    /** @type {any} */
    let sessionCwd = null
    let prevTs = 0
    let prevHuman = null
    const closeSeg = () => {
      if (seg && seg.dur === null) seg.dur = Math.max(0, seg.last - seg.start)
      seg = null
    }
    /** @param {any} run @param {number} ts */
    const openSeg = (run, ts) => {
      closeSeg()
      seg = { run, start: ts, last: ts, dur: null }
      run.segs.push(seg)
      cur = run
    }
    await eachLine(io, f, o => {
      const ts = Date.parse(o.timestamp)
      if (o.cwd && !sessionCwd) sessionCwd = o.cwd
      if (o.type === 'system' && o.subtype === 'turn_duration') {
        stat.durationLines++
        stat.durationMs += Number(o.durationMs) || 0
        if (cur && seg && seg.dur === null) { seg.dur = Number(o.durationMs) || 0; seg.line = true; seg = null }
        else if (cur) cur.extraMs += Number(o.durationMs) || 0
        return
      }
      if (o.type === 'user') {
        const c = o.message?.content
        if (Array.isArray(c) && c[0]?.type === 'tool_result') {
          noteToolResult(cur?.st ?? st, o, ts)
          if (cur && seg) { seg.last = Math.max(seg.last, ts); cur.owner.prevTs = ts }
          return
        }
        if (o.isMeta) return
        const text = textOf(c)
        const kind = o.origin?.kind
        if (kind === 'task-notification') {
          const m = /<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/.exec(text.slice(0, 3000))
          const rid = m && toolToRun.get(m[1] ?? '')
          const tid = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(text.slice(0, 3000))
          const run = (rid && fileRuns.get(rid)) || (tid && fileRuns.get(toolToRun.get(tid[1] ?? '') ?? '')) || null
          if (run) { openSeg(run, ts); run.owner.prevTs = ts }
          else if (cur) { /* unknown owner: stays with the current run */ }
          return
        }
        if (/^\s*\[Request interrupted/.test(text)) {
          if (cur && seg) { seg.aborted = true; seg.last = Math.max(seg.last, ts) }
          return
        }
        const isHuman = kind === 'human' || (!o.origin && (o.promptSource === 'sdk' || o.turnOrigin === 'sdk'))
        if (!isHuman || NOTICE.test(text) || text.trim() === '') return
        const cmdM = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(text.slice(0, 600))
        const runId = o.promptId ?? o.uuid
        let run = runs.get(runId) ?? null
        if (run && run.sessionId !== sessionId) { stat.dupRuns++; run = null }
        if (run) { // same prompt seen again in this file: keep one run
          openSeg(run, ts); run.owner.prevTs = ts
          return
        }
        stat.humanPrompts++
        const origin = kind === 'human' ? (o.promptSource === 'typed' || !o.promptSource ? 'composer' : o.promptSource) : 'sdk'
        run = {
          runId, sessionId, start: ts, promptChars: text.length, origin,
          command: cmdM ? cmdM[1] : null, cwd: o.cwd ?? sessionCwd, root: sessionCwd,
          permissionMode: o.permissionMode ?? null, version: o.version ?? null,
          segs: [], extraMs: 0, owner: newOwner(ts), st: { pending: st.pending, agentUse: st.agentUse, skills: [], skillWork: [], work: 0, edited: [], read: [] },
        }
        runs.set(runId, run)
        fileRuns.set(runId, run)
        openSeg(run, ts)
        return
      }
      if (o.type === 'assistant' && cur) {
        if (seg) seg.last = Math.max(seg.last, ts)
        noteAssistant(cur.st, cur.owner, o, ts, cur.root, opts.vault)
        cur.owner.prevTs = ts
        for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
          if ((b?.type === 'tool_use') && (b.name === 'Agent' || b.name === 'Task')) toolToRun.set(b.id, cur.runId)
        }
      }
    })
    closeSeg()

    // subagents of this session
    for (const sf of io.subFiles(sessionId)) {
      stat.subFiles++
      const agentId = sf.slice('agent-'.length, -'.jsonl'.length)
      const meta = io.meta(`${sessionId}/subagents/${sf.replace(/\.jsonl$/, '.meta.json')}`) ?? {}
      const sst = { pending: new Map(), agentUse: new Map(), skills: [], skillWork: [], work: 0, edited: [], read: [] }
      const owner = newOwner(0)
      /** @type {any} */
      const rec = { sessionId, agentId, meta, owner, st: sst, firstTs: null, lastTs: 0, promptId: null, root: null, version: null, cwdName: null, children: [] }
      await eachLine(io, `${sessionId}/subagents/${sf}`, o => {
        const ts = Date.parse(o.timestamp)
        if (!Number.isFinite(ts)) return
        if (o.type !== 'user' && o.type !== 'assistant') return
        if (rec.firstTs === null) { rec.firstTs = ts; owner.start = ts; owner.prevTs = ts; rec.root = o.cwd ?? null; rec.version = o.version ?? null }
        if (!rec.promptId && o.promptId) rec.promptId = o.promptId
        if (o.type === 'user') {
          if (noteToolResult(sst, o, ts)) { rec.lastTs = Math.max(rec.lastTs, ts); owner.prevTs = ts }
          return
        }
        rec.lastTs = Math.max(rec.lastTs, ts)
        noteAssistant(sst, owner, o, ts, rec.root, opts.vault)
        owner.prevTs = ts
        for (const b of Array.isArray(o.message?.content) ? o.message.content : [])
          if (b?.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task')) toolToSub.set(b.id, rec)
      })
      if (rec.firstTs !== null) subs.push(rec)
    }
  }

  // Resolve each subagent to its run: meta.toolUseId -> the parent's Agent tool_use -> run.
  const subById = new Map(subs.map(r => [`${r.sessionId}/${r.agentId}`, r]))
  /** @param {any} rec */
  const runOfSub = rec => {
    for (let hops = 0, cur = rec; hops < 8 && cur; hops++) {
      const tu = cur.meta.toolUseId
      if (tu && toolToRun.has(tu)) return toolToRun.get(tu)
      if (cur.promptId && runs.has(cur.promptId)) return cur.promptId
      cur = (tu && toolToSub.get(tu)) || (cur.meta.parentAgentId && subById.get(`${cur.sessionId}/${cur.meta.parentAgentId}`)) || null
    }
    // A forked agent with no spawning tool call: the session's run that was going when it started.
    let root = rec
    for (let hops = 0; hops < 8 && root.meta.parentAgentId; hops++) root = subById.get(`${root.sessionId}/${root.meta.parentAgentId}`) ?? root
    let best = null
    for (const r of runs.values()) if (r.sessionId === rec.sessionId && r.start <= root.firstTs && (!best || r.start > best.start)) best = r
    return best ? best.runId : null
  }

  /** @type {any[]} */
  const rows = []
  /** @param {number} ts */
  const tzOf = ts => new Date(ts).getTimezoneOffset()
  const classes = new Map()
  for (const run of runs.values()) {
    /** @type {Seg[]} */
    const segs = run.segs
    const segEnd = Math.max(...segs.map(s => s.last), run.start)
    const dur = segs.reduce((a, s) => a + (s.dur ?? Math.max(0, s.last - s.start)), 0) + run.extraMs
    const hasDur = segs.some(s => s.dur !== null && s.dur !== Math.max(0, s.last - s.start)) || run.extraMs > 0
    const end = Math.max(segEnd, run.start)
    const b = build(run.owner, run.start, end, null)
    if (b.steps.length === 0 && b.tools.length === 0 && dur === 0) { run.skip = true; continue }
    const cls = classifyRun({ skills: run.st.skills, command: run.command, skillWork: run.st.skillWork, editedPaths: run.st.edited, readPaths: run.st.read, ignore: opts.ignore, projectsFolder: opts.projectsFolder ?? '' })
    const task = { ...cls, job: null, promptChars: run.promptChars, origin: run.origin, runStart: run.start }
    classes.set(run.runId, task)
    const ms = round(dur)
    // A turn_duration line already leaves out the time spent waiting on the person
    // (AskUserQuestion, ExitPlanMode), so only waits inside timestamp-measured
    // segments are taken out of `ms`. Taking the whole tool wait out of a
    // turn_duration sum zeroed agentMs of runs that paused for answers.
    const waitMs = Math.min(lengthOf(unionSpans(segs.filter(s => !s.line).flatMap(s => clip(waitSpansOf(run.owner), [s.start, s.last])))), ms)
    const sleepMs = 0
    const hour = new Date(run.start)
    run.out = {
      v: 1, kind: 'turn', src: 'backfill', machineId: machine, sessionId: run.sessionId, runId: run.runId, turnId: run.runId,
      agentId: null, parentAgentId: null, agentType: null, background: null,
      model: b.model, effort: b.effort, start: run.start, end,
      ms, agentMs: Math.max(0, ms - waitMs - sleepMs), modelMs: b.modelMs, toolMs: b.toolMs, waitMs, sleepMs,
      outcome: segs.some(s => s.aborted) ? 'aborted' : 'finished',
      tokens: b.tokens, usd: b.usd, ...(b.unpriced ? { unpriced: true } : {}),
      steps: b.steps, tools: b.tools, errors: b.errors, task,
      cond: {
        contextStart: null, contextTurn: b.contextTurn, cache: b.cache,
        hour: hour.getHours(), weekday: hour.getDay(), tzOffsetMin: tzOf(run.start),
        permissionMode: run.permissionMode, version: run.version,
        cwdName: normalizePath(run.cwd ?? '').split('/').filter(Boolean).pop() ?? '',
      },
      _durFromLines: hasDur,
    }
    rows.push(run.out)
  }
  for (const rec of subs) {
    const runId = runOfSub(rec)
    const run = runId ? runs.get(runId) : null
    if (!run || run.skip) { stat.orphanSubagents++; if (opts.debug) /** @type {any} */ (globalThis).console.error('orphan', rec.sessionId, rec.agentId, JSON.stringify(rec.meta).slice(0, 200), rec.promptId, !!run); continue }
    const end = rec.lastTs || rec.firstTs
    const b = build(rec.owner, rec.firstTs, end, null)
    const ms = Math.max(0, round(end - rec.firstTs))
    const waitMs = Math.min(b.waitMs, ms)
    const t = new Date(rec.firstTs)
    rows.push({
      v: 1, kind: 'turn', src: 'backfill', machineId: machine, sessionId: rec.sessionId, runId, turnId: rec.agentId,
      agentId: rec.agentId, parentAgentId: null, agentType: rec.meta.agentType ?? null,
      background: rec.meta.requestShape === 'background' ? true : null,
      model: b.model, effort: b.effort, start: rec.firstTs, end,
      ms, agentMs: Math.max(0, ms - waitMs), modelMs: b.modelMs, toolMs: b.toolMs, waitMs, sleepMs: 0,
      outcome: 'finished', tokens: b.tokens, usd: b.usd, ...(b.unpriced ? { unpriced: true } : {}),
      steps: b.steps, tools: b.tools, errors: b.errors, task: classes.get(runId),
      cond: {
        contextStart: null, contextTurn: b.contextTurn, cache: b.cache,
        hour: t.getHours(), weekday: t.getDay(), tzOffsetMin: tzOf(rec.firstTs),
        permissionMode: null, version: rec.version, cwdName: normalizePath(rec.root ?? '').split('/').filter(Boolean).pop() ?? '',
      },
    })
  }

  // Live wins: runs the live recorder already logged are not written.
  const liveIds = io.liveRunIds()
  const skipped = rows.filter(r => liveIds.has(r.runId))
  const kept = rows.filter(r => !liveIds.has(r.runId))
  for (const r of kept) delete r._durFromLines

  /** @type {Map<string, any[]>} */
  const byMonth = new Map()
  for (const r of kept) {
    const d = new Date(r.start)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    if (!byMonth.has(key)) byMonth.set(key, [])
    byMonth.get(key)?.push(r)
  }
  for (const list of byMonth.values()) list.sort((a, b) => a.start - b.start)
  return { stat, rows, kept, skipped, runs, liveIds, byMonth }
}

/** @param {Map<string, any>} runs */
function allMainSegs(runs) {
  const r = { line: { n: 0, ms: 0 }, fallback: { n: 0, ms: 0 }, extra: 0 }
  for (const run of runs.values()) {
    if (!run.out) continue
    r.extra += run.extraMs
    for (const s of run.segs) {
      const k = s.line ? r.line : r.fallback
      k.n++; k.ms += s.dur ?? Math.max(0, s.last - s.start)
    }
  }
  return r
}

/**
 * @param {any} res
 * @param {any} opts
 */
export function summarize(res, opts) {
  const { stat, kept, skipped, runs } = res
  /** @type {any[]} */
  const mainRows = kept.filter((/** @type {any} */ r) => !r.agentId)
  const out = []
  out.push(`transcripts: ${stat.files} main, ${stat.subFiles} subagent; turn_duration lines ${stat.durationLines} (${(stat.durationMs / 3.6e6).toFixed(2)} h)`)
  out.push(`human prompts counted ${stat.humanPrompts}; runs built ${[...runs.values()].filter(r => r.out).length}; duplicated runIds across files ${stat.dupRuns}; orphan subagents ${stat.orphanSubagents}`)
  const allMain = [...runs.values()].filter(r => r.out)
  const segs = allMainSegs(runs)
  out.push(`segments: ${segs.line.n} closed by a turn_duration (${(segs.line.ms / 3.6e6).toFixed(2)} h), ${segs.fallback.n} by timestamps (${(segs.fallback.ms / 3.6e6).toFixed(2)} h), further turn_duration lines ${(segs.extra / 3.6e6).toFixed(2)} h`)
  out.push(`main-turn ms total ${(allMain.reduce((a, r) => a + r.out.ms, 0) / 3.6e6).toFixed(2)} h`)
  out.push(`rows: ${kept.length} written (${mainRows.length} main, ${kept.length - mainRows.length} subagent); skipped as already live: ${new Set(skipped.map((/** @type {any} */ r) => r.runId)).size} runs`)
  for (const r of skipped.filter((/** @type {any} */ x) => !x.agentId).slice(0, 10)) out.push(`  skipped live ${r.runId} session ${r.sessionId} backfill usd ${r.usd}`)
  const ts = kept.map((/** @type {any} */ r) => r.start)
  if (ts.length) out.push(`range ${new Date(Math.min(...ts)).toISOString().slice(0, 10)} .. ${new Date(Math.max(...ts)).toISOString().slice(0, 10)}`)
  const byModel = new Map()
  for (const r of kept) {
    const m = byModel.get(r.model) ?? { rows: 0, ms: 0, usd: 0, unpriced: 0 }
    m.rows++; m.ms += r.ms; if (r.usd === null) m.unpriced++; else m.usd += r.usd
    byModel.set(r.model, m)
  }
  out.push('by model (rows, hours, usd at API prices):')
  for (const [k, m] of [...byModel].sort((a, b) => b[1].usd - a[1].usd)) out.push(`  ${k}: ${m.rows} rows, ${(m.ms / 3.6e6).toFixed(2)} h, $${m.usd.toFixed(2)}${m.unpriced ? ` (${m.unpriced} unpriced)` : ''}`)
  out.push(`total usd $${kept.reduce((/** @type {number} */ a, /** @type {any} */ r) => a + (r.usd ?? 0), 0).toFixed(2)}`)
  const byType = new Map()
  for (const r of mainRows) {
    const k = r.task.taskType
    byType.set(k, [...(byType.get(k) ?? []), r.ms])
  }
  out.push('top task types (runs, median seconds):')
  for (const [k, v] of [...byType].sort((a, b) => b[1].length - a[1].length).slice(0, 10)) out.push(`  ${k}: ${v.length}, ${((median(v) ?? 0) / 1000).toFixed(0)} s`)
  out.push(opts.dryRun ? 'dry run: nothing written' : `wrote ${res.byMonth.size} file(s) for machine ${opts.machine}`)
  return out.join('\n')
}


/**
 * The disk writeOut works on: the write rule's view (lstat, realPath; see
 * lib/safepath.mjs) and the operations themselves. scripts/backfill.mjs hands
 * in node:fs, the tests a disk in memory.
 * @typedef {import('../lib/safepath.mjs').PathIo & { join: (...parts: string[]) => string, mkdir: (dir: string) => void, list: (dir: string) => string[], remove: (file: string) => void, write: (file: string, text: string) => void }} Disk
 */

const BACKFILL_ROLL_BYTES = 3.5 * 1024 * 1024
const BACKFILL_FILE = /^backfill-\d{4}-\d{2}(\.part\d+)?\.jsonl$/
const encoder = new TextEncoder()

/**
 * Throws when the shared write rule refuses `target` under the vault.
 * @param {Disk} disk
 * @param {string} vault
 * @param {string} target
 */
async function check(disk, vault, target) {
  const refusal = await writeRefusal(disk, vault, target)
  if (refusal !== null) throw new Error(`nothing written: ${refusal}`)
}

/**
 * Replaces the machine's backfill files with the months of this run, and
 * writes `.vault-eta/.gitignore` (`*`) when it is missing. A month past
 * 3.5 MiB goes on in `backfill-YYYY-MM.part2.jsonl` and so on: the mod's
 * file API reads at most 4 MiB at a time. Every folder made, file deleted
 * and file written passes the shared write rule first, so a symbolic link
 * at `.vault-eta`, `runs`, the machine folder, the ignore file or a month
 * file stops the run before anything changes.
 * @param {{ vault: string, machine: string }} opts
 * @param {{ byMonth: Map<string, unknown[]> }} res
 * @param {Disk} disk
 */
export async function writeOut(opts, res, disk) {
  const { vault } = opts
  const outDir = disk.join(vault, '.vault-eta', 'runs', opts.machine)
  const gitignore = disk.join(vault, '.vault-eta', '.gitignore')
  // the folders on the way and the ignore file, before any of them is made
  await check(disk, vault, disk.join(outDir, 'backfill-check.jsonl'))
  await check(disk, vault, gitignore)
  /** @type {string[]} */
  const old = (await disk.lstat(outDir)) === null ? [] : disk.list(outDir).filter(f => BACKFILL_FILE.test(f))
  for (const f of old) await check(disk, vault, disk.join(outDir, f))
  /** @type {Array<[string, string]>} */
  const files = []
  for (const [key, list] of res.byMonth) {
    /** @type {string[][]} */
    const parts = [[]]
    let bytes = 0
    for (const r of list) {
      const line = JSON.stringify(r) + '\n'
      const size = encoder.encode(line).length
      if (bytes + size > BACKFILL_ROLL_BYTES && bytes > 0) {
        parts.push([])
        bytes = 0
      }
      parts[parts.length - 1]?.push(line)
      bytes += size
    }
    parts.forEach((lines, i) => files.push([disk.join(outDir, i === 0 ? `backfill-${key}.jsonl` : `backfill-${key}.part${i + 1}.jsonl`), lines.join('')]))
  }
  // every file this run writes, before anything changes
  for (const [file] of files) await check(disk, vault, file)
  disk.mkdir(outDir)
  if ((await disk.lstat(gitignore)) === null) disk.write(gitignore, '*\n')
  for (const f of old) disk.remove(disk.join(outDir, f))
  for (const [file, text] of files) {
    await check(disk, vault, file)
    disk.write(file, text)
  }
}
