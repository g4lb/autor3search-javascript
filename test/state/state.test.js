import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  STATE_HOME_ENV,
  benchPattern,
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
