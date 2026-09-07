import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearStop, requestStop, stopRequested } from '../../src/state/stop.js'

let dir
beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), 'a3s-stop-')), 'run')
})

describe('stop sentinel', () => {
  it('reports no request before one is made', async () => {
    expect(await stopRequested(dir)).toBe(false)
  })

  it('creates the state directory rather than failing on a missing one', async () => {
    // A human reaching for the brake must never be told the directory does
    // not exist yet.
    await requestStop(dir)
    expect(await stopRequested(dir)).toBe(true)
  })

  it('is idempotent', async () => {
    await requestStop(dir)
    await requestStop(dir)
    expect(await stopRequested(dir)).toBe(true)
  })

  it('clears a pending request', async () => {
    await requestStop(dir)
    await clearStop(dir)
    expect(await stopRequested(dir)).toBe(false)
  })

  it('does not error clearing a request that was never made', async () => {
    await expect(clearStop(dir)).resolves.toBeUndefined()
  })

  it('reports false rather than throwing when the sentinel is unreadable', async () => {
    // A stop that cannot be read must never abort a run by itself — the human
    // still has --force and Ctrl+C.
    await rm(dir, { recursive: true, force: true })
    expect(await stopRequested(dir)).toBe(false)
  })
})
