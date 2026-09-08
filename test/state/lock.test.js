import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { LOCK_DIR, claimEval, clearEvalLock, evalRunning } from '../../src/state/lock.js'

let dir
beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), 'a3s-lock-')), 'run')
})

describe('claimEval', () => {
  it('reports no eval running before a claim', async () => {
    expect(await evalRunning(dir)).toEqual({ pid: null, running: false })
  })

  it('claims and reports the running pid', async () => {
    const claim = await claimEval(dir)
    expect(await evalRunning(dir)).toEqual({ pid: process.pid, running: true })
    await claim.release()
  })

  it('releases the claim so a later eval can take it', async () => {
    await (await claimEval(dir)).release()
    expect((await evalRunning(dir)).running).toBe(false)
    await (await claimEval(dir)).release()
  })

  it('refuses a second concurrent claim and names the incumbent', async () => {
    const claim = await claimEval(dir)
    await expect(claimEval(dir)).rejects.toThrow(new RegExp(`pid ${process.pid}`))
    await expect(claimEval(dir)).rejects.toThrow(/already running/)
    await claim.release()
  })

  it('takes over a lock whose owner is dead and whose heartbeat is cold', async () => {
    // pid 2^22 is above the default pid_max on Linux and macOS, so it cannot
    // be alive; an ancient heartbeat completes the staleness test.
    await mkdir(join(dir, LOCK_DIR), { recursive: true })
    await writeFile(join(dir, LOCK_DIR, 'pid'), '4194304')
    await writeFile(join(dir, LOCK_DIR, 'heartbeat'), String(Date.now() - 600_000))
    const claim = await claimEval(dir)
    expect((await evalRunning(dir)).pid).toBe(process.pid)
    await claim.release()
  })

  it('does NOT take over a lock whose heartbeat is fresh, even if the pid looks dead', async () => {
    await mkdir(join(dir, LOCK_DIR), { recursive: true })
    await writeFile(join(dir, LOCK_DIR, 'pid'), '4194304')
    await writeFile(join(dir, LOCK_DIR, 'heartbeat'), String(Date.now()))
    await expect(claimEval(dir)).rejects.toThrow(/already running/)
  })

  it('does NOT take over a lock whose owner is alive, however old the heartbeat', async () => {
    await mkdir(join(dir, LOCK_DIR), { recursive: true })
    await writeFile(join(dir, LOCK_DIR, 'pid'), String(process.pid))
    await writeFile(join(dir, LOCK_DIR, 'heartbeat'), String(Date.now() - 600_000))
    await expect(claimEval(dir)).rejects.toThrow(/already running/)
  })

  it('refuses a pid file holding a value it must never signal', async () => {
    // `stop --force` signals the pid's process GROUP, and kill(-1) means every
    // process the caller may signal — so a pid file holding 1 would turn a
    // wedged experiment into a session-wide kill.
    await mkdir(join(dir, LOCK_DIR), { recursive: true })
    await writeFile(join(dir, LOCK_DIR, 'pid'), '1')
    await writeFile(join(dir, LOCK_DIR, 'heartbeat'), String(Date.now()))
    await expect(evalRunning(dir)).rejects.toThrow(/not a process this command will signal/)
  })

  it('refuses an unparseable pid rather than guessing', async () => {
    await mkdir(join(dir, LOCK_DIR), { recursive: true })
    await writeFile(join(dir, LOCK_DIR, 'pid'), 'not-a-pid')
    await writeFile(join(dir, LOCK_DIR, 'heartbeat'), String(Date.now()))
    await expect(evalRunning(dir)).rejects.toThrow(/is not a pid/)
  })

  it('refreshes the heartbeat while the claim is held', async () => {
    const claim = await claimEval(dir)
    const first = (await evalRunning(dir)).heartbeat
    await new Promise((r) => setTimeout(r, 50))
    await claim.touch()
    expect((await evalRunning(dir)).heartbeat).toBeGreaterThanOrEqual(first)
    await claim.release()
  })

  it('clears a lock left behind, without erroring on a missing one', async () => {
    await (await claimEval(dir)).release()
    await expect(clearEvalLock(dir)).resolves.toBeUndefined()
    await expect(clearEvalLock(dir)).resolves.toBeUndefined()
  })
})
