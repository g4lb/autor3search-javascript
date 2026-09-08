/**
 * The eval claim: at most one `eval` may run against a given run at a time.
 *
 * Two concurrent evals is itself a bug — they would fight over the same
 * pinned worktree — so a claim that cannot be taken is reported as an error
 * naming the incumbent pid rather than silently proceeding.
 *
 * Node has no flock binding, so the claim is an atomic mkdir of a lock
 * directory holding the owner's pid and a heartbeat it refreshes. A lock is
 * stale only when BOTH the pid is not alive AND the heartbeat has gone cold:
 * pids are recycled, so liveness alone would eventually let one run steal
 * another's claim, and a heartbeat alone would strand a lock whose owner was
 * SIGKILLed.
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { ensureSecureDir } from './index.js'
import { join } from 'node:path'

export const LOCK_DIR = 'eval.lock'

/** How often a live eval refreshes its heartbeat. */
export const HEARTBEAT_MS = 5_000

/** How cold a heartbeat must be before a dead owner's lock is reclaimed. */
export const STALE_AFTER_MS = 30_000

/**
 * Claims the run in stateDir for this process.
 *
 * @param {string} stateDir
 * @param {number} [pid]
 * @returns {Promise<{release(): Promise<void>, touch(): Promise<void>}>}
 * @throws {Error} when a live eval already holds the claim
 */
export async function claimEval(stateDir, pid = process.pid) {
  await ensureSecureDir(stateDir)
  const lockPath = join(stateDir, LOCK_DIR)

  for (;;) {
    try {
      await mkdir(lockPath)
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      const held = await readLock(lockPath)
      if (!(await isStale(held, lockPath))) {
        throw new Error(
          `another autor3search-javascript eval (pid ${held.pid ?? 'unknown'}) is already running for this run`,
        )
      }
      // Stale: the owner is gone and its heartbeat is cold. Take it over by
      // removing the abandoned directory and retrying the atomic mkdir — this
      // keeps two racing processes from both believing they won: only one
      // mkdir can succeed per iteration, and a loser that lands here again
      // rereads the (now fresh) lock and refuses like any other contender.
      await rm(lockPath, { recursive: true, force: true }).catch(() => {})
    }
  }

  const touch = async () => {
    await writeFile(join(lockPath, 'heartbeat'), String(Date.now()))
  }
  await writeFile(join(lockPath, 'pid'), String(pid))
  await touch()

  const timer = setInterval(() => {
    touch().catch(() => {})
  }, HEARTBEAT_MS)
  // Never hold the event loop open on the heartbeat alone.
  timer.unref?.()

  return {
    touch,
    async release() {
      clearInterval(timer)
      await rm(lockPath, { recursive: true, force: true })
    },
  }
}

/**
 * Reports the pid of the eval currently running for this run.
 *
 * A pid file that exists but does not hold a plausible pid is an ERROR, not a
 * missing one: the value is about to be handed to a kill(2), where a
 * non-positive target means something far broader than one process. Refusing
 * to guess is the only safe reading of a corrupt file.
 *
 * The documented shape is `{pid, running}`; `heartbeat` rides along as a
 * non-enumerable extra for callers (and tests) that want to observe it
 * advancing, without changing what a deep-equality check against the
 * documented shape sees.
 *
 * @returns {Promise<{pid: number|null, running: boolean, heartbeat?: number}>}
 */
export async function evalRunning(stateDir) {
  const lockPath = join(stateDir, LOCK_DIR)
  const held = await readLock(lockPath)
  if (held.error) throw held.error
  if (held.pid === null && held.heartbeat === null && !(await stat(lockPath).catch(() => null))) {
    return withHeartbeat(null, false, null)
  }
  const stale = await isStale(held, lockPath)
  return withHeartbeat(stale ? null : held.pid, !stale, held.heartbeat)
}

/** Builds an evalRunning result with heartbeat attached non-enumerably. */
function withHeartbeat(pid, running, heartbeat) {
  const result = { pid, running }
  Object.defineProperty(result, 'heartbeat', { value: heartbeat, enumerable: false })
  return result
}

/** Removes a lock left behind. Removing one that is not there is not an error. */
export async function clearEvalLock(stateDir) {
  await rm(join(stateDir, LOCK_DIR), { recursive: true, force: true })
}

/** Reads the lock directory's contents, deferring pid validation to the caller. */
async function readLock(lockPath) {
  const pidText = await readFile(join(lockPath, 'pid'), 'utf8').catch(() => null)
  const beatText = await readFile(join(lockPath, 'heartbeat'), 'utf8').catch(() => null)
  const heartbeat = beatText === null ? null : Number(beatText.trim())

  if (pidText === null) return { pid: null, heartbeat, error: null }
  const trimmed = pidText.trim()
  // Require the pid file to hold nothing but an integer (with optional sign):
  // Number() would otherwise accept '', ' ', '0x10', 'Infinity', and other
  // strings no process id can be.
  const isIntegerText = /^-?\d+$/.test(trimmed)
  const pid = isIntegerText ? Number(trimmed) : NaN
  if (!isIntegerText || !Number.isSafeInteger(pid)) {
    return {
      pid: null,
      heartbeat,
      error: new Error(`${join(lockPath, 'pid')}: ${JSON.stringify(trimmed)} is not a pid`),
    }
  }
  // pid <= 1 is refused, not just pid <= 0: kill(1, ...) targets init/launchd
  // (every process on the system on some platforms), and kill(-1, ...) - the
  // exact form `stop --force` uses for its own valid pids - means "every
  // process the caller may signal". A pid file holding either must never be
  // read back and handed to process.kill.
  if (pid <= 1) {
    return {
      pid: null,
      heartbeat,
      error: new Error(`${join(lockPath, 'pid')}: pid ${pid} is not a process this command will signal`),
    }
  }
  return { pid, heartbeat, error: null }
}

/**
 * A lock is stale only when its owner is gone AND its heartbeat is cold.
 *
 * When neither a pid nor a heartbeat can be read, the lock directory exists
 * but is (so far) empty. That happens in exactly two situations, and they
 * must not be confused: another claimant's mkdir just won and it has not yet
 * written its pid/heartbeat files (a race lasting microseconds), or a past
 * claimant crashed between its mkdir and those writes and the directory is
 * permanently abandoned. Time is what tells them apart — so this falls back
 * to the lock DIRECTORY's own age against the same staleness window, rather
 * than ever treating "unreadable" as "absent" the way an empty pid/heartbeat
 * pair alone would. Without this, one claimEval racing another could delete
 * and recreate the winner's still-forming lock directory out from under it,
 * and both callers would believe they held the claim.
 */
async function isStale(held, lockPath) {
  if (held.error) return false
  if (held.pid !== null && alive(held.pid)) return false
  if (held.heartbeat !== null && Number.isFinite(held.heartbeat)) {
    return Date.now() - held.heartbeat > STALE_AFTER_MS
  }
  const dirStat = await stat(lockPath).catch(() => null)
  if (!dirStat) return true // lock directory is gone entirely: nothing to protect
  return Date.now() - dirStat.mtimeMs > STALE_AFTER_MS
}

/** Signal 0 tests for the existence of a process without touching it. */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return err.code === 'EPERM'
  }
}
