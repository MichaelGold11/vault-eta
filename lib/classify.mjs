// @ts-check
// What kind of work a run is, and the few safe facts kept about each tool
// call. Nothing here keeps text: a Bash command keeps its first words, a file
// tool its folder inside the vault (`(outside)` for anything else), an Edit
// its line counts.

/**
 * Forward slashes, no doubled or trailing separator, a drive letter in lower
 * case: `C:\Users\m\vault\` and `c:/Users/m/vault` read the same.
 * @param {unknown} p
 * @returns {string}
 */
export function normalizePath(p) {
  let s = String(p ?? '').trim().replace(/\\/g, '/')
  const unc = s.startsWith('//')
  s = s.replace(/\/{2,}/g, '/')
  if (unc) s = `/${s}`
  if (/^[A-Za-z]:/.test(s)) s = s[0]?.toLowerCase() + s.slice(1)
  if (s.length > 1 && s.endsWith('/') && !/^[a-z]:\/$/.test(s)) s = s.slice(0, -1)
  return s
}

/**
 * The path under `cwd`, or null when it lies outside. Compared without case,
 * as macOS and Windows file systems do by default.
 * @param {unknown} path
 * @param {unknown} cwd
 * @returns {string | null}
 */
export function relativePath(path, cwd) {
  const p = normalizePath(path)
  const root = normalizePath(cwd)
  if (root === '' || p === '') return null
  if (p.toLowerCase() === root.toLowerCase()) return '.'
  const prefix = root.endsWith('/') ? root : `${root}/`
  if (p.toLowerCase().startsWith(prefix.toLowerCase())) return p.slice(prefix.length)
  if (!/^([a-z]:)?\//.test(p)) return p.replace(/^\.\//, '')
  return null
}

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookRead'])
const DIR_TOOLS = new Set(['Grep', 'Glob', 'LS'])
export const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/**
 * The path a file tool works on: the file for Read, Write and Edit, the
 * folder searched for Grep and Glob.
 * @param {string} tool
 * @param {any} input
 * @returns {{ path: string, isDir: boolean } | null}
 */
export function toolPath(tool, input) {
  if (!input || typeof input !== 'object') return null
  if (FILE_TOOLS.has(tool)) {
    const path = input.file_path ?? input.notebook_path
    return typeof path === 'string' && path !== '' ? { path, isDir: false } : null
  }
  if (DIR_TOOLS.has(tool)) {
    const path = input.path
    return typeof path === 'string' && path !== '' ? { path, isDir: true } : { path: '.', isDir: true }
  }
  return null
}

/** What a path outside the vault (or the project folder) is kept as: no part of it. */
export const OUTSIDE = '(outside)'

/** A last segment that names a file (`plan.md`, `.env.local`), not a folder: a dot with something before it, then an extension. */
const FILE_NAME = /.\.[A-Za-z0-9]{1,10}$/

/**
 * The folder of a path inside `cwd`, relative to it and cut to `depth`
 * segments: `01-projects/website/plan` for a note in that folder. A file's
 * name is never kept: for a search tool's path (`isDir`) that names a file,
 * its folder. A path outside `cwd` (absolute elsewhere, `~`, or climbing out
 * with `..`) is kept as `(outside)`, so no user name, client folder or file
 * name from elsewhere on the machine reaches the log.
 * @param {string} path
 * @param {boolean} isDir
 * @param {unknown} cwd
 * @param {number} [depth]
 * @returns {string}
 */
export function folderOf(path, isDir, cwd, depth = 4) {
  const rel = relativePath(path, cwd)
  if (rel === null) return OUTSIDE
  const parts = rel.split('/').filter(s => s !== '' && s !== '.')
  if (parts.includes('..') || (parts[0] ?? '').startsWith('~')) return OUTSIDE
  const last = parts[parts.length - 1]
  if (last !== undefined && (!isDir || FILE_NAME.test(last))) parts.pop()
  return parts.length === 0 ? '.' : parts.slice(0, depth).join('/')
}

/**
 * @param {unknown} s
 * @returns {number}
 */
export function lineCount(s) {
  const t = String(s ?? '')
  if (t === '') return 0
  const breaks = (t.match(/\n/g) ?? []).length
  return t.endsWith('\n') ? breaks : breaks + 1
}

/**
 * Lines written and lines replaced by an edit, from its arguments' shape
 * alone: `[added, removed]`, or undefined for a tool that edits nothing.
 * @param {string} tool
 * @param {any} input
 * @returns {[number, number] | undefined}
 */
export function linesChanged(tool, input) {
  if (!input || typeof input !== 'object') return undefined
  if (tool === 'Edit') return [lineCount(input.new_string), lineCount(input.old_string)]
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    let added = 0
    let removed = 0
    for (const edit of input.edits) {
      added += lineCount(edit?.new_string)
      removed += lineCount(edit?.old_string)
    }
    return [added, removed]
  }
  if (tool === 'Write') return [lineCount(input.content), 0]
  if (tool === 'NotebookEdit') return input.edit_mode === 'delete' ? [0, 0] : [lineCount(input.new_source), 0]
  return undefined
}

const WRAPPERS = new Set(['sudo', 'time', 'env', 'nohup', 'exec', 'command'])
/** A wrapper's flags that take a value (`sudo -u postgres`, `env -u NAME`): the value is skipped, never taken for the command. */
const WRAPPER_VALUE_FLAGS = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '--user', '--group', '--host', '--prompt', '--chdir', '--role', '--type', '--other-user', '--close-from', '--command-timeout']),
  env: new Set(['-u', '-C', '-S', '--unset', '--chdir', '--split-string']),
  time: new Set(['-f', '-o', '--format', '--output']),
  exec: new Set(['-a']),
}
/** The command's own name: letters, digits and `._+-` (no `:` or `@`, which a host, a URL or a credential has). */
const PROGRAM = /^[a-z0-9][a-z0-9._+-]{0,39}$/i
const SCRIPT = /\.(mjs|cjs|js|ts|tsx|sh|ps1|py|rb)$/i
const SCRIPT_NAME = /^[a-z][a-z0-9:_-]{0,29}$/
const INTERPRETERS = new Set(['node', 'bun', 'deno', 'tsx', 'python', 'python3', 'bash', 'sh', 'zsh', 'pwsh', 'powershell', 'ruby'])
const PACKAGE_RUNNERS = new Set(['bun', 'npm', 'pnpm', 'yarn'])
/** The only words kept after a tool's name; anything else could be a branch, host or file. */
const SUBCOMMANDS = {
  git: 'add bisect blame branch checkout cherry-pick clean clone commit diff fetch grep init log ls-files merge mv pull push rebase remote reset restore rev-parse revert rm show stash status switch tag worktree',
  bun: 'add build create dev i install link outdated pm publish remove run test update upgrade x',
  npm: 'add ci create exec i install link outdated publish remove run start test uninstall update',
  pnpm: 'add create dev dlx exec i install link outdated publish remove run start test update',
  yarn: 'add create dev install link outdated publish remove run start test upgrade',
  gh: 'api auth issue pr release repo run search workflow',
  claude: 'mcp plugin',
  docker: 'build compose exec ps pull push run',
  vercel: 'deploy env link login logs whoami',
  supabase: 'db functions gen link migration start status stop',
}
/** A third word is kept only from this list (`gh pr create`, `claude plugin test`, `supabase db push`). */
const VERBS = new Set('add apply build checkout close comment create deploy diff disable down edit enable list logs merge new pull push remove reset start status stop test up update validate view watch'.split(' '))
/** @type {Record<string, Set<string>>} */
const KNOWN = Object.fromEntries(Object.entries(SUBCOMMANDS).map(([tool, list]) => [tool, new Set(list.split(' '))]))

/**
 * The first words of a shell command, never its arguments: `bun run build`,
 * `git push`, `node find.mjs`. The tool's name is kept; a second or
 * third word only from a known list (or a script's file name after an
 * interpreter, or a package script after `run`). A leading `cd ... &&`,
 * variable assignments, flags, paths and quotes are skipped or end it.
 * @param {unknown} command
 * @returns {string}
 */
export function commandHead(command) {
  const first = String(command ?? '').split('\n')[0] ?? ''
  const segments = first.split(/&&|\|\||;|\|/).map(s => s.trim()).filter(Boolean)
  const segment = segments.find(s => !/^(cd|pushd|set-location|sl)\b/i.test(s)) ?? segments[0] ?? ''
  const tokens = segment.split(/\s+/).filter(Boolean)
  /** @type {string[]} */
  const out = []
  let skipNext = false
  let isDone = false
  /** The wrapper in front of the command, while its own flags are read. */
  let wrapper = ''
  for (const raw of tokens) {
    if (isDone || out.length >= 3) break
    if (skipNext) {
      skipNext = false
      continue
    }
    if (out.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) continue
    if (out.length === 0 && WRAPPERS.has(raw)) {
      wrapper = raw
      continue
    }
    if (raw.startsWith('-')) {
      if (out.length === 0) {
        const takesValue = /** @type {Record<string, Set<string>>} */ (WRAPPER_VALUE_FLAGS)[wrapper]?.has(raw.split('=')[0] ?? raw)
        if (takesValue && !raw.includes('=')) skipNext = true
      } else if (/^-[A-Za-z]$/.test(raw)) skipNext = /^-[Cc]$/.test(raw)
      continue
    }
    if (/["'`$<>(){}]/.test(raw) || raw.includes('=')) break
    const isPath = raw.includes('/') || raw.includes('\\')
    const word = isPath ? raw.split(/[\\/]/).pop() ?? '' : raw
    if (out.length === 0) {
      if (!PROGRAM.test(word)) break
      out.push(word.toLowerCase().replace(/\.exe$/, ''))
      continue
    }
    const tool = out[0] ?? ''
    if (out.length === 1 && INTERPRETERS.has(tool) && SCRIPT.test(word) && PROGRAM.test(word)) {
      out.push(word)
      isDone = true
    } else if (isPath) {
      break
    } else if (out.length === 1 && KNOWN[tool]?.has(raw)) {
      out.push(raw)
    } else if (out.length === 2 && PACKAGE_RUNNERS.has(tool) && out[1] === 'run' && SCRIPT_NAME.test(raw)) {
      out.push(raw)
    } else if (out.length === 2 && KNOWN[tool] && VERBS.has(raw)) {
      out.push(raw)
    } else {
      break
    }
  }
  return out.join(' ')
}

/**
 * `website` from `website-work`, the naming for a project's skill.
 * @param {unknown} name
 * @returns {string | null}
 */
export function projectFromSkill(name) {
  const m = /^(.+)-work$/i.exec(String(name ?? ''))
  return m && m[1] ? m[1].toLowerCase() : null
}

/**
 * True for a top-level folder name that holds projects: `Projects`,
 * `01-projects`, `1 Projects`, `10 projects`, `project`, any case. A number
 * prefix (digits, then a dash, dot, underscore or space) is ignored.
 * @param {unknown} name
 * @returns {boolean}
 */
export function isProjectsFolder(name) {
  return /^(\d+[-_. ]+)?projects?$/i.test(String(name ?? '').trim())
}

/**
 * The project a path is in: the folder under the vault's projects folder, or
 * null. `projectsFolder` (the userConfig option) names that folder, as a
 * vault-relative path such as `Work/Projects`; empty means auto-detect: the
 * first folder of the path, if its name passes `isProjectsFolder`. A path
 * that is not vault-relative (absolute, outside the vault) has no project.
 * @param {unknown} path
 * @param {string} [projectsFolder]
 * @returns {string | null}
 */
export function projectFromPath(path, projectsFolder = '') {
  const parts = normalizePath(path).split('/').filter(s => s !== '' && s !== '.')
  if (/^([a-z]:)?\//.test(normalizePath(path))) return null
  const base = normalizePath(projectsFolder).split('/').filter(s => s !== '' && s !== '.')
  let at = 0
  if (base.length > 0) {
    if (parts.length <= base.length || !base.every((seg, i) => seg.toLowerCase() === (parts[i] ?? '').toLowerCase())) return null
    at = base.length
  } else if (parts.length < 2 || !isProjectsFolder(parts[0])) {
    return null
  } else {
    at = 1
  }
  const name = parts[at] ?? ''
  const isFile = at === parts.length - 1 && /\.[a-z0-9]+$/i.test(name)
  return name !== '' && !isFile ? name.toLowerCase() : null
}

/**
 * @param {readonly string[]} paths
 * @param {string} [projectsFolder]
 * @returns {string | null}
 */
function mostCommonProject(paths, projectsFolder = '') {
  /** @type {Map<string, number>} */
  const counts = new Map()
  for (const p of paths) {
    const project = projectFromPath(p, projectsFolder)
    if (project) counts.set(project, (counts.get(project) ?? 0) + 1)
  }
  let best = null
  let most = 0
  for (const [project, n] of counts) {
    if (n > most) {
      best = project
      most = n
    }
  }
  return best
}

/**
 * A comma or space separated list from a setting: `"kickoff, triage"`.
 * @param {unknown} value
 * @returns {string[]}
 */
export function parseList(value) {
  return String(value ?? '')
    .split(/[\s,]+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Skills that help with a task rather than name it, in any setup: they load
 * partway through whatever the work is (browser, design, charts, authoring,
 * setup). Skipped like the user's `ignoreSkills` when naming a run. A name
 * with a `plugin:` prefix is compared by its last part.
 */
export const GENERIC_HELPERS = [
  'artifact-capabilities',
  'artifact-design',
  'artifact-diagramming',
  'claude-in-chrome',
  'built-in-browser',
  'chrome-browser',
  'computer-use',
  'dataviz',
  'plugin-authoring',
  'find-skills',
  'update-config',
  'keybindings-help',
  'fewer-permission-prompts',
]

/**
 * @param {string} name
 * @returns {string}
 */
function bareName(name) {
  const at = name.lastIndexOf(':')
  return (at < 0 ? name : name.slice(at + 1)).toLowerCase()
}

/**
 * A skill followed by another naming skill with at most this many other tool
 * calls between them is a router (it only hands over), and does not name the run.
 */
export const ROUTER_MAX_WORK = 0

/**
 * @typedef {{ skills?: readonly string[], helpers?: readonly string[], command?: string | null, editedPaths?: readonly string[], readPaths?: readonly string[], ignore?: readonly string[], skillWork?: readonly number[], projectsFolder?: string }} RunFacts
 * @typedef {{ taskType: string, skill: string | null, command: string | null, project: string | null }} RunClass
 */

/**
 * The task type is the first skill that names the run, else its slash
 * command, else `freeform`. A skill is skipped when it is on the user's
 * ignore list (routing skills like `kickoff`) or is a generic helper
 * (`helpers`, GENERIC_HELPERS unless the caller passes its own list; `[]`
 * turns it off): a helper loaded mid-task is not what the task was. The
 * project comes from the naming skill's name (`website-work`), else from
 * the folders the run edited, else from the folders it read.
 * @param {RunFacts} facts
 * @returns {RunClass}
 */
export function classifyRun(facts) {
  const ignore = new Set((facts.ignore ?? []).map(s => s.toLowerCase()))
  const helpers = new Set((facts.helpers ?? GENERIC_HELPERS).map(s => s.toLowerCase()))
  const skills = facts.skills ?? []
  const names = skills.map(s => s !== '' && !ignore.has(s.toLowerCase()) && !helpers.has(s.toLowerCase()) && !helpers.has(bareName(s)))
  const work = facts.skillWork
  const isRouter = (/** @type {number} */ i) => {
    const here = work?.[i]
    if (here === undefined) return false
    for (let j = i + 1; j < skills.length; j++) {
      const there = work?.[j]
      if (names[j] && there !== undefined && there - here <= ROUTER_MAX_WORK) return true
    }
    return false
  }
  const at = skills.findIndex((_, i) => names[i] && !isRouter(i))
  const skill = at < 0 ? null : (skills[at] ?? null)
  const rawCommand = facts.command ? String(facts.command).replace(/^\//, '') : null
  const command = rawCommand && !ignore.has(rawCommand.toLowerCase()) ? rawCommand : null
  const taskType = skill ?? command ?? 'freeform'
  const folder = facts.projectsFolder ?? ''
  const project =
    projectFromSkill(skill) ??
    projectFromSkill(command) ??
    mostCommonProject(facts.editedPaths ?? [], folder) ??
    mostCommonProject(facts.readPaths ?? [], folder)
  return { taskType, skill, command, project }
}

const AGENT_NAMES = new Set(['Agent', 'Task'])
const SHELL_NAMES = new Set(['Bash', 'PowerShell'])
/** A run's shape is read from its first this-many model requests, and is known once the next one begins. */
export const SHAPE_STEPS = 2
/**
 * The estimate kept as a run's estimate at submit is made as the prompt is
 * sent and refreshed through its first this-many main model requests, as they
 * settle which task it is (hooks/register.tsx, Recorder.setEstimate): its
 * labels are the ones known by then.
 */
export const SUBMIT_STEPS = 2
/** How much a run did, least to most: nothing but an answer, looked at things, ran commands, changed files, handed work to agents. */
export const SHAPES = /** @type {const} */ (['answer', 'read', 'shell', 'edit', 'agents'])

/**
 * The shape of the work from the names of the tools called so far (never
 * their arguments): the most involved kind wins.
 * @param {Iterable<string>} names
 * @returns {'answer' | 'read' | 'shell' | 'edit' | 'agents'}
 */
export function shapeOf(names) {
  let rank = 0
  for (const name of names) {
    const r = AGENT_NAMES.has(name) ? 4 : EDIT_TOOLS.has(name) ? 3 : SHELL_NAMES.has(name) ? 2 : 1
    if (r > rank) rank = r
  }
  return SHAPES[rank] ?? 'answer'
}

/**
 * True for a prompt the person sent (typed, from the phone bridge, or an SDK
 * host's own turn).
 * @param {{ kind?: unknown } | null | undefined} origin
 * @returns {boolean}
 */
export function isPersonPrompt(origin) {
  const kind = origin?.kind
  return kind === 'composer' || kind === 'bridge' || kind === 'sdk'
}

/**
 * A turn the engine starts to hand the model a background task's result.
 * @param {unknown} text
 * @returns {boolean}
 */
export function isNoticeText(text) {
  return /^\s*<(task-notification|agent-message|background-task|system-reminder)\b/.test(String(text ?? ''))
}

/**
 * The background task a notification is about (`<task-id>...</task-id>`): the
 * id alone, never the text around it.
 * @param {unknown} text
 * @returns {string | null}
 */
export function taskIdOf(text) {
  const m = /<task-id>\s*([^<\s]{1,200})\s*<\/task-id>/.exec(String(text ?? '').slice(0, 4000))
  return m && m[1] ? m[1] : null
}
