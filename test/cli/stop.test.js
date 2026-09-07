import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STATE_HOME_ENV, stateDir } from '../../src/state/index.js'
import { stopRequested } from '../../src/state/stop.js'
import { runCli } from '../helpers/cli.js'
import { makeBenchRepo } from '../helpers/bench-repo.js'
import { commitFiles } from '../helpers/repo.js'

const original = process.env[STATE_HOME_ENV]
beforeEach(async () => {
  process.env[STATE_HOME_ENV] = await mkdtemp(join(tmpdir(), 'a3s-stop-home-'))
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

describe('stop', () => {
  it('writes a request the next eval will report', async () => {
    const dir = await ready()
    const { code, out } = await runCli(['stop', '-C', dir])
    expect(code).toBe(0)
    expect(await stopRequested(await stateDir(dir, 't'))).toBe(true)
    expect(out).toMatch(/after the current experiment/)
  })

  it('clears a pending request with --clear', async () => {
    const dir = await ready()
    await runCli(['stop', '-C', dir])
    const { code, out } = await runCli(['stop', '-C', dir, '--clear'])
    expect(code).toBe(0)
    expect(await stopRequested(await stateDir(dir, 't'))).toBe(false)
    expect(out).toMatch(/cancelled/i)
  })

  it('says plainly when --force finds no eval running', async () => {
    const dir = await ready()
    const { code, out } = await runCli(['stop', '-C', dir, '--force'])
    expect(code).toBe(0)
    expect(out).toMatch(/no eval is running/i)
  })

  it('still writes the request when --force finds nothing to signal', async () => {
    const dir = await ready()
    await runCli(['stop', '-C', dir, '--force'])
    expect(await stopRequested(await stateDir(dir, 't'))).toBe(true)
  })

  it('reports the repository state and does not change it', async () => {
    const dir = await ready()
    const { out } = await runCli(['stop', '-C', dir, '--force'])
    expect(out).toMatch(/git reset --hard HEAD~1/)
    const { isClean } = await import('../../src/gitx.js')
    expect(await isClean(dir)).toBe(true)
  })

  it('rejects --clear together with --force', async () => {
    const dir = await ready()
    const { code, err } = await runCli(['stop', '-C', dir, '--clear', '--force'])
    expect(code).not.toBe(0)
    expect(err).toMatch(/--clear and --force/)
  })

  it('works from another branch when given -tag', async () => {
    const dir = await ready()
    const { checkout } = await import('../../src/gitx.js')
    await checkout(dir, 'main')
    expect((await runCli(['stop', '-C', dir, '-tag', 't'])).code).toBe(0)
  })
})
