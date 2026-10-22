import type { EngineInterface } from 'claude-code'

import { writeRefusal } from '../lib/safepath.mjs'

// The mod's one rule for where it writes (lib/safepath.mjs) over $.fs: the
// report, the log files and the .gitignore all go through it.

type Engine = EngineInterface

/** What a path is without following it: a link (one leading nowhere included), a file or a folder; null when nothing is there. */
async function lstatOf($: Engine, path: string): Promise<{ isLink: boolean; kind: 'file' | 'dir' | 'other' } | null> {
  const st = await $.fs.stat(path).catch(() => undefined)
  if (st) return { isLink: st.isLink, kind: st.kind }
  // a link that leads nowhere may not stat: its folder's listing still names it
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (cut <= 0) return null
  try {
    const entry = (await $.fs.list(path.slice(0, cut))).find(e => e.name === path.slice(cut + 1))
    return entry?.isLink ? { isLink: true, kind: 'other' } : null
  } catch {
    return null
  }
}

/** Why the mod may not write `path` under `base` (see writeRefusal), or null when it may. */
export function refusalOf($: Engine, base: string, path: string, options: { linkedFolders?: boolean } = {}): Promise<string | null> {
  return writeRefusal(
    {
      lstat: p => lstatOf($, p),
      realPath: async p => (await $.fs.stat(p, { resolve: true }).catch(() => undefined))?.realPath ?? null,
    },
    base,
    path,
    options,
  )
}
