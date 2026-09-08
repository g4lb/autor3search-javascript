import { chmod, lstat, mkdtemp, readFile, readlink, stat, symlink, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  STATE_HOME_ENV,
  benchPattern,
  ensureSecureDir,
  linkNodeModules,
  loadBaseline,
  saveBaseline,
  stateDir,
  validTag,
} from '../../src/state/index.js'

let home, repo
const original = process.env[STATE_HOME_ENV]

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'a3s-home-'))
  repo = await mkdtemp(join(tmpdir(), 'a3s-state-repo-'))
  process.env[STATE_HOME_ENV] = home
})
afterEach(() => {
  if (original === undefined) delete process.env[STATE_HOME_ENV]
  else process.env[STATE_HOME_ENV] = original
})

describe('validTag', () => {
  it('accepts letters, digits, dot, underscore and hyphen', () => {
    for (const tag of ['sep4', 'v1.2', 'run_1', 'a-b']) expect(() => validTag(tag)).not.toThrow()
  })

  it('rejects an empty tag', () => {
    expect(() => validTag('')).toThrow(/must not be empty/)
  })

  it('rejects a directory reference', () => {
    expect(() => validTag('.')).toThrow(/directory reference/)
    expect(() => validTag('..')).toThrow(/directory reference/)
  })

  it('rejects a path separator, blocking traversal and absolute paths', () => {
    expect(() => validTag('../../etc')).toThrow(/only letters/)
    expect(() => validTag('/etc/passwd')).toThrow(/only letters/)
    expect(() => validTag('a/b')).toThrow(/only letters/)
  })

  it('rejects other punctuation', () => {
    expect(() => validTag('a b')).toThrow(/only letters/)
    expect(() => validTag('a;b')).toThrow(/only letters/)
  })
})

describe('stateDir', () => {
  it('lives under the state home, keyed by repository and tag', async () => {
    const dir = await stateDir(repo, 'sep4')
    expect(dir.startsWith(home)).toBe(true)
    expect(dir.endsWith('/sep4')).toBe(true)
  })

  it('gives different repositories different keys', async () => {
    const other = await mkdtemp(join(tmpdir(), 'a3s-state-repo-'))
    expect(await stateDir(repo, 'x')).not.toBe(await stateDir(other, 'x'))
  })

  it('gives the same repository reached two ways the same key', async () => {
    expect(await stateDir(repo, 'x')).toBe(await stateDir(join(repo, '.', ''), 'x'))
  })

  it('validates the tag before it ever reaches a filesystem path', async () => {
    await expect(stateDir(repo, '../../escape')).rejects.toThrow(/only letters/)
  })

  it('refuses a relative state home', async () => {
    process.env[STATE_HOME_ENV] = 'relative/path'
    await expect(stateDir(repo, 'x')).rejects.toThrow(/must be an absolute path/)
  })

  it('falls back to the user cache when the override is unset', async () => {
    delete process.env[STATE_HOME_ENV]
    expect(await stateDir(repo, 'x')).toContain('autor3search-javascript')
  })
})

describe('baseline persistence', () => {
  const record = {
    tag: 'sep4',
    branch: 'autor3search-javascript/sep4',
    commit: 'a3f1c2d',
    measureCommit: 'a3f1c2d',
    createdAt: '2026-09-07T10:00:00.000Z',
    benchmarks: ['parse'],
    pattern: '^(parse)$',
    configSha256: 'f'.repeat(64),
  }

  it('round-trips through disk', async () => {
    const path = join(home, 'sep4', 'baseline.json')
    await saveBaseline(path, record)
    expect(await loadBaseline(path)).toEqual(record)
  })

  it('creates parent directories', async () => {
    const path = join(home, 'deep', 'nested', 'baseline.json')
    await saveBaseline(path, record)
    expect(JSON.parse(await readFile(path, 'utf8')).tag).toBe('sep4')
  })

  it('defaults measureCommit to commit for a record written before it existed', async () => {
    const path = join(home, 'old.json')
    const { measureCommit, ...withoutMeasure } = record
    await mkdir(home, { recursive: true })
    await writeFile(path, JSON.stringify(withoutMeasure))
    expect((await loadBaseline(path)).measureCommit).toBe('a3f1c2d')
  })

  it('names the command to run when there is no baseline yet', async () => {
    await expect(loadBaseline(join(home, 'missing.json'))).rejects.toThrow(/baseline/)
  })
})

describe('linkNodeModules', () => {
  it('symlinks the repository node_modules into a worktree that has none', async () => {
    await mkdir(join(repo, 'node_modules'), { recursive: true })
    await writeFile(join(repo, 'node_modules', 'marker.txt'), 'x\n')
    const worktree = await mktempDir()

    await linkNodeModules(repo, worktree)

    const stats = await lstat(join(worktree, 'node_modules'))
    expect(stats.isSymbolicLink()).toBe(true)
    expect(await readlink(join(worktree, 'node_modules'))).toBe(join(repo, 'node_modules'))
    expect(await readFile(join(worktree, 'node_modules', 'marker.txt'), 'utf8')).toBe('x\n')
  })

  it('is a no-op when the repository has no node_modules', async () => {
    const worktree = await mktempDir()
    await expect(linkNodeModules(repo, worktree)).resolves.toBeUndefined()
    await expect(lstat(join(worktree, 'node_modules'))).rejects.toThrow()
  })

  it('is a no-op when the worktree already has a node_modules', async () => {
    await mkdir(join(repo, 'node_modules'), { recursive: true })
    const worktree = await mktempDir()
    await mkdir(join(worktree, 'node_modules'), { recursive: true })
    await writeFile(join(worktree, 'node_modules', 'already-here.txt'), 'y\n')

    await linkNodeModules(repo, worktree)

    const stats = await lstat(join(worktree, 'node_modules'))
    expect(stats.isSymbolicLink()).toBe(false) // untouched — still the real directory, not replaced
    expect(await readFile(join(worktree, 'node_modules', 'already-here.txt'), 'utf8')).toBe('y\n')
  })

  it('never throws, even when the worktree directory does not exist yet', async () => {
    await mkdir(join(repo, 'node_modules'), { recursive: true })
    const missingWorktree = join(tmpdir(), 'a3s-does-not-exist-' + Math.random().toString(36).slice(2))
    await expect(linkNodeModules(repo, missingWorktree)).resolves.toBeUndefined()
  })
})

/** A fresh empty directory, standing in for a pinned worktree. */
async function mktempDir() {
  return mkdtemp(join(tmpdir(), 'a3s-worktree-'))
}

describe('benchPattern', () => {
  it('matches everything for an empty list', () => {
    expect(benchPattern([])).toBe('.')
  })

  it('anchors an alternation of the named benchmarks', () => {
    expect(benchPattern(['parse', 'format'])).toBe('^(parse|format)$')
  })

  it('escapes regexp metacharacters in a hand-typed name', () => {
    // A stray metacharacter would otherwise silently BROADEN the pattern to
    // match benchmarks nobody selected.
    expect(new RegExp(benchPattern(['a.b'])).test('axb')).toBe(false)
    expect(new RegExp(benchPattern(['a.b'])).test('a.b')).toBe(true)
  })
})

describe('ensureSecureDir', () => {
  // The state home holds the frozen store and its manifest. Write access there
  // is write access to what the score is measured against, so these tests are
  // about that, not about tidiness.
  const posix = typeof process.getuid === 'function'

  it.skipIf(!posix)('creates the directory private to the current user', async () => {
    const dir = await ensureSecureDir(await stateDir(repo, 'perms'))
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    expect((await stat(home)).mode & 0o777).toBe(0o700)
  })

  it.skipIf(!posix)('refuses a run directory other users can write', async () => {
    const dir = await stateDir(repo, 'wide')
    await ensureSecureDir(dir)
    await chmod(dir, 0o777)
    await expect(ensureSecureDir(dir)).rejects.toThrow(/mode 777 lets other users write/)
  })

  it.skipIf(!posix)('refuses when an ANCESTOR under the state home is writable', async () => {
    // Owning the parent is enough to replace the child, so checking only the
    // leaf would miss the case that matters: someone pre-creating the
    // per-repository level and swapping the store underneath a 0700 run dir.
    const dir = await stateDir(repo, 'ancestor')
    await ensureSecureDir(dir)
    await chmod(dirname(dir), 0o777)
    await expect(ensureSecureDir(dir)).rejects.toThrow(/refusing to use/)
    await chmod(dirname(dir), 0o700)
    await expect(ensureSecureDir(dir)).resolves.toBe(dir)
  })

  it.skipIf(!posix)('names the offending directory and the command that fixes it', async () => {
    const dir = await stateDir(repo, 'message')
    await ensureSecureDir(dir)
    await chmod(dir, 0o707)
    await expect(ensureSecureDir(dir)).rejects.toThrow(new RegExp(`chmod 700 .*${'message'}`))
  })

  it.skipIf(!posix)('accepts a state home that merely SITS in a shared directory', async () => {
    // A 0700 home inside a sticky /tmp is fine — mkdtemp puts every one of
    // these tests there. Only levels at or below the home are checked.
    const dir = await stateDir(repo, 'undertmp')
    await expect(ensureSecureDir(dir)).resolves.toBe(dir)
  })
})
