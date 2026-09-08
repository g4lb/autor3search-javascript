/**
 * The sentinel coordinating between the human's shell and the agent's loop.
 *
 * It lives out-of-tree alongside the rest of the run state, for the same
 * reason everything else there does: a sentinel inside the repository would
 * dirty the working tree the agent commits from, and would have to be
 * special-cased in the scope gate and in .gitignore. Out here it is invisible
 * to every gate and to git, and both `stop` and `eval` still find it because
 * the state directory is derived from the repository path and run tag, not
 * from anything either process holds privately.
 */
import { rm, stat, writeFile } from 'node:fs/promises'
import { ensureSecureDir } from './index.js'
import { join } from 'node:path'

/**
 * Marks that the human has asked the run to end. `eval` reports its presence
 * alongside the verdict; the AGENT decides when to act on it, which is what
 * makes a graceful stop graceful — nothing here interrupts an experiment
 * already under way.
 */
export const STOP_REQUEST_FILE = 'stop.request'

/**
 * Asks the run in stateDir to end after the current experiment.
 *
 * Creating stateDir when missing is deliberate: a human reaching for the
 * brake should never be told the directory does not exist yet. A request
 * against a tag whose baseline never finished is harmless — the sentinel
 * simply sits there until a run reads it, or clearStop removes it.
 */
export async function requestStop(stateDir) {
  await ensureSecureDir(stateDir)
  await writeFile(join(stateDir, STOP_REQUEST_FILE), 'stop requested\n')
}

/** Cancels a pending request. Clearing one never made is not an error. */
export async function clearStop(stateDir) {
  await rm(join(stateDir, STOP_REQUEST_FILE), { force: true })
}

/**
 * Reports whether a stop is pending.
 *
 * Returns a boolean rather than throwing, because every caller wants the same
 * answer for an unreadable sentinel as for an absent one: carry on. A stop
 * that cannot be read must never abort a run by itself.
 *
 * @returns {Promise<boolean>}
 */
export async function stopRequested(stateDir) {
  return stat(join(stateDir, STOP_REQUEST_FILE)).then(
    () => true,
    () => false,
  )
}
