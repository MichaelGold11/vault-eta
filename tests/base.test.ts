import { describe, expect, test } from 'claude-code/testing'

import { cutMark, parentOf, resolveBase, slashPath } from '../lib/base.mjs'

// Where `.vault-eta/` lives, from a fake tree: folder -> entry names.
function io(tree: Record<string, string[]>, home = '/Users/me') {
  return { home, namesIn: async (dir: string) => tree[dir] ?? null }
}

const VAULT = '/Users/me/notes'

describe('the base folder', () => {
  test('cutMark and parentOf', () => {
    expect(cutMark('/a/.vault-eta/runs/m1')).toBe('/a')
    expect(cutMark('/.vault-eta/runs')).toBe('/')
    expect(cutMark('/a/b')).toBe('/a/b')
    expect(parentOf('/a/b')).toBe('/a')
    expect(parentOf('/a')).toBe('/')
    expect(parentOf('/')).toBeNull()
  })

  test('from the vault root', async () => {
    expect(await resolveBase(VAULT, io({ [VAULT]: ['.vault-eta', '.git'] }))).toBe(VAULT)
  })

  test('from a subfolder: up to the nearest folder that has .vault-eta', async () => {
    const tree = { [VAULT]: ['.vault-eta', '.git'], [`${VAULT}/01-projects`]: ['website'], [`${VAULT}/01-projects/website`]: ['.git'] }
    // the nearest .vault-eta wins over a nearer .git
    expect(await resolveBase(`${VAULT}/01-projects/website`, io(tree))).toBe(VAULT)
  })

  test('from inside .vault-eta/runs/x: cut off, then the same answer as the root', async () => {
    const tree = { [VAULT]: ['.vault-eta'], [`${VAULT}/.vault-eta`]: ['runs'], [`${VAULT}/.vault-eta/runs/m1`]: [] }
    expect(await resolveBase(`${VAULT}/.vault-eta/runs/m1`, io(tree))).toBe(VAULT)
    // a nested one left by the old bug resolves to the real base too
    expect(await resolveBase(`${VAULT}/.vault-eta/runs/m1/.vault-eta/runs/m1`, io(tree))).toBe(VAULT)
  })

  test('no .vault-eta anywhere: the nearest .git, else the folder itself', async () => {
    const tree = { [`${VAULT}/app`]: ['.git', 'src'], [`${VAULT}/app/src`]: [], [VAULT]: [] }
    expect(await resolveBase(`${VAULT}/app/src`, io(tree))).toBe(`${VAULT}/app`)
    expect(await resolveBase('/Users/me/scratch/x', io({}))).toBe('/Users/me/scratch/x')
  })

  test('Windows paths walk up the same way, stop at the drive root and at USERPROFILE, in any case', async () => {
    expect(slashPath('C:\\Users\\me\\notes\\')).toBe('C:/Users/me/notes')
    expect(slashPath('C:')).toBe('C:/')
    expect(parentOf('C:\\Users')).toBe('C:/')
    expect(parentOf('C:\\')).toBeNull()
    expect(parentOf('\\\\server\\share\\notes')).toBe('//server/share')
    expect(parentOf('//server/share')).toBeNull()
    expect(cutMark('C:\\Users\\me\\notes\\.vault-eta\\runs\\m1')).toBe('C:/Users/me/notes')
    const tree = { 'C:/Users/me/notes': ['.vault-eta', '.git'], 'C:/Users/me/notes/01-projects': ['web'], 'C:/Users/me/notes/01-projects/web': [] }
    const win = (home: string) => ({ home, namesIn: async (dir: string) => (tree as Record<string, string[]>)[dir] ?? null })
    expect(await resolveBase('C:\\Users\\me\\notes\\01-projects\\web', win('C:\\Users\\me'))).toBe('C:/Users/me/notes')
    // home is not taken for a subfolder, whatever its case
    const atHome = { 'C:/Users/me': ['.vault-eta'] }
    expect(await resolveBase('C:\\Users\\me\\play', { home: 'c:\\users\\ME', namesIn: async (dir: string) => (atHome as Record<string, string[]>)[dir] ?? null })).toBe('C:/Users/me/play')
    // a network share is the top of its walk
    const share = { '//server/share': ['.vault-eta'] }
    expect(await resolveBase('\\\\server\\share\\notes', { namesIn: async (dir: string) => (share as Record<string, string[]>)[dir] ?? null })).toBe('//server/share/notes')
  })

  test('stops at home: a .vault-eta or .git in home is not taken for a subfolder', async () => {
    const tree = { '/Users/me': ['.vault-eta', '.git'], '/Users/me/play': [] }
    expect(await resolveBase('/Users/me/play', io(tree))).toBe('/Users/me/play')
    expect(await resolveBase('/Users/me', io(tree))).toBe('/Users/me')
  })
})
