import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as gitx from '../../src/gitx.js'
import { STATE_HOME_ENV, loadBaseline, stateDir } from '../../src/state/index.js'
import { runCli } from '../helpers/cli.js'
import { makeBenchRepo } from '../helpers/bench-repo.js'
import { commitFiles, writeFiles } from '../helpers/repo.js'

const original = process.env[STATE_HOME_ENV]
beforeEach(async () => {
  process.env[STATE_HOME_ENV] = await mkdtemp(join(tmpdir(), 'a3s-bl-home-'))
})
afterEach(() => {
  if (original === undefined) delete process.env[STATE_HOME_ENV]
  else process.env[STATE_HOME_ENV] = original
})

/** A repo with init already run and everything committed. */
async function initialised() {
  const dir = await makeBenchRepo()
  await runCli(['init', '-C', dir])
  await commitFiles(dir, {}, 'init')
  return dir
}

describe('baseline', () => {
  it('creates the run branch and records the baseline', async () => {
    const dir = await initialised()
    const { code } = await runCli(['baseline', '-C', dir, '-tag', 'sep7'])
    expect(code).toBe(0)
    expect(await gitx.currentBranch(dir)).toBe('autor3search-javascript/sep7')
    const record = await loadBaseline(join(await stateDir(dir, 'sep7'), 'baseline.json'))
    expect(record.tag).toBe('sep7')
    expect(record.measureCommit).toBe(record.commit)
    expect(record.benchmarks).toEqual(['countWords'])
  })

  it('freezes both the test and the bench file', async () => {
    const dir = await initialised()
    await runCli(['baseline', '-C', dir, '-tag', 'sep7'])
    const manifest = JSON.parse(await readFile(join(await stateDir(dir, 'sep7'), 'frozen/manifest.json'), 'utf8'))
    expect(Object.keys(manifest.files).sort()).toEqual(['src/wordcount.bench.js', 'src/wordcount.test.js'])
  })

  it('pins a detached worktree at the baseline commit', async () => {
    const dir = await initialised()
    await runCli(['baseline', '-C', dir, '-tag', 'sep7'])
    const wt = join(await stateDir(dir, 'sep7'), 'baseline-worktree')
    expect(await gitx.headCommit(wt)).toBe(await gitx.headCommit(dir))
  })

  it('records the config hash', async () => {
    const dir = await initialised()
    await runCli(['baseline', '-C', dir, '-tag', 'sep7'])
    const record = await loadBaseline(join(await stateDir(dir, 'sep7'), 'baseline.json'))
    expect(record.configSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses a dirty tree and explains why', async () => {
    const dir = await initialised()
    await writeFiles(dir, { 'src/wordcount.js': '// edited\n' })
    const { code, err } = await runCli(['baseline', '-C', dir, '-tag', 'sep7'])
    expect(code).not.toBe(0)
    expect(err).toMatch(/uncommitted|dirty/i)
    expect(err).toMatch(/reproducible/)
  })

  it('refuses a reused tag', async () => {
    const dir = await initialised()
    await runCli(['baseline', '-C', dir, '-tag', 'sep7'])
    await gitx.checkout(dir, 'main')
    const { code, err } = await runCli(['baseline', '-C', dir, '-tag', 'sep7'])
    expect(code).not.toBe(0)
    expect(err).toMatch(/already exists/)
  })

  it('refuses a traversal tag before touching the filesystem', async () => {
    const dir = await initialised()
    const { code, err } = await runCli(['baseline', '-C', dir, '-tag', '../../escape'])
    expect(code).not.toBe(0)
    expect(err).toMatch(/only letters/)
  })

  it('refuses when results.tsv already holds rows, unless forced', async () => {
    const dir = await initialised()
    await writeFile(join(dir, 'results.tsv'), 'commit\tscore\tbest_bench_delta\tbytes_delta\tstatus\tdescription\nabc\t0.9\t-1\t0\tkeep\tx\n')
    const refused = await runCli(['baseline', '-C', dir, '-tag', 'sep7'])
    expect(refused.code).not.toBe(0)
    expect(refused.err).toMatch(/--force/)
    const forced = await runCli(['baseline', '-C', dir, '-tag', 'sep8', '--force'])
    expect(forced.code).toBe(0)
  })

  it('refuses when init has not been run', async () => {
    const dir = await makeBenchRepo()
    const { code, err } = await runCli(['baseline', '-C', dir, '-tag', 'sep7'])
    expect(code).not.toBe(0)
    expect(err).toMatch(/init/)
  })

  it('cleans up the run branch when it fails partway through', async () => {
    const dir = await initialised()
    // A tag whose state directory cannot be created: point the state home at
    // a path that is a regular file, so mkdir fails after the branch exists.
    const blocked = join(await mkdtemp(join(tmpdir(), 'a3s-blocked-')), 'file')
    await writeFile(blocked, 'x')
    process.env[STATE_HOME_ENV] = blocked
    const { code } = await runCli(['baseline', '-C', dir, '-tag', 'sep9'])
    expect(code).not.toBe(0)
    expect(await gitx.currentBranch(dir)).toBe('main')
    expect(await gitx.branchExists(dir, 'autor3search-javascript/sep9')).toBe(false)
  })

  it('defaults the tag to a date-shaped slug', async () => {
    const dir = await initialised()
    const { code, out } = await runCli(['baseline', '-C', dir])
    expect(code).toBe(0)
    expect(out).toMatch(/autor3search-javascript\/[a-z]{3}\d{1,2}/)
  })

  it('reports the worktree path and the stop command', async () => {
    const dir = await initialised()
    const { out } = await runCli(['baseline', '-C', dir, '-tag', 'sep7'])
    expect(out).toContain('baseline-worktree')
    expect(out).toContain('autor3search-javascript stop')
  })

  it('accepts the -tag spelling program.md tells the agent to use', async () => {
    const dir = await initialised()
    expect((await runCli(['baseline', '-C', dir, '-tag', 'sep7'])).code).toBe(0)
  })
})
