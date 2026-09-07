import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as gitx from '../../src/gitx.js'
import { STATE_HOME_ENV, stateDir } from '../../src/state/index.js'
import { claimEval } from '../../src/state/lock.js'
import { requestStop } from '../../src/state/stop.js'
import { runCli } from '../helpers/cli.js'
import { makeBenchRepo } from '../helpers/bench-repo.js'
import { commitFiles, writeFiles } from '../helpers/repo.js'

const original = process.env[STATE_HOME_ENV]
beforeEach(async () => {
  process.env[STATE_HOME_ENV] = await mkdtemp(join(tmpdir(), 'a3s-status-home-'))
})
afterEach(() => {
  if (original === undefined) delete process.env[STATE_HOME_ENV]
  else process.env[STATE_HOME_ENV] = original
})

async function ready() {
  const dir = await makeBenchRepo()
  await runCli(['init', '-C', dir])
  await commitFiles(dir, {}, 'init')
  await runCli(['baseline', '-C', dir, '-tag', 't'])
  return dir
}

describe('status', () => {
  it('reports the run branch, baseline and worktree', async () => {
    const dir = await ready()
    const { code, out } = await runCli(['status', '-C', dir])
    expect(code).toBe(0)
    expect(out).toMatch(/run tag\s+t/)
    expect(out).toMatch(/autor3search-javascript\/t\s+\(checked out\)/)
    expect(out).toContain('baseline-worktree')
  })

  it('reports zero experiments before any eval', async () => {
    const { out } = await runCli(['status', '-C', await ready()])
    expect(out).toMatch(/experiments\s+0 run/)
    expect(out).toMatch(/next is #1/)
  })

  it('counts experiments by verdict', async () => {
    const dir = await ready()
    await writeFiles(dir, {
      'results.tsv':
        'commit\tscore\tbest_bench_delta\tbytes_delta\tstatus\tdescription\n' +
        'a\t0.9\t-10\t0\tkeep\tone\n' +
        'b\t1.0\t0\t0\tdiscard\ttwo\n' +
        'c\t0\t0\t0\tfail\tthree\n',
    })
    const { out } = await runCli(['status', '-C', dir])
    expect(out).toMatch(/3 run/)
    expect(out).toMatch(/1 keep/)
    expect(out).toMatch(/1 discard/)
    expect(out).toMatch(/1 fail/)
  })

  it('reports a running eval and a pending stop', async () => {
    const dir = await ready()
    const state = await stateDir(dir, 't')
    const claim = await claimEval(state)
    await requestStop(state)
    const { out } = await runCli(['status', '-C', dir])
    expect(out).toMatch(new RegExp(`running \\(pid ${process.pid}\\)`))
    expect(out).toMatch(/stop\s+requested/)
    await claim.release()
  })

  it('works from another branch when given -tag', async () => {
    const dir = await ready()
    await gitx.checkout(dir, 'main')
    const { code, out } = await runCli(['status', '-C', dir, '-tag', 't'])
    expect(code).toBe(0)
    expect(out).toMatch(/not checked out/)
  })

  it('writes nothing to the state directory', async () => {
    const dir = await ready()
    const state = await stateDir(dir, 't')
    const before = (await readdir(state)).sort()
    await runCli(['status', '-C', dir])
    expect((await readdir(state)).sort()).toEqual(before)
  })

  it('prints the two stop commands', async () => {
    const { out } = await runCli(['status', '-C', await ready()])
    expect(out).toContain('autor3search-javascript stop')
    expect(out).toContain('--force')
  })
})
