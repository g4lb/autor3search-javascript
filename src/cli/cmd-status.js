/**
 * Prints where a run is. READ-ONLY: checking on a run must never change it,
 * which is why nothing here writes, claims, or clears anything.
 */
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import * as gitx from '../gitx.js'
import { RESULTS_PATH, loadRows } from '../results.js'
import { BASELINE_FILE, WORKTREE_NAME, loadBaseline } from '../state/index.js'
import { evalRunning } from '../state/lock.js'
import { stopRequested } from '../state/stop.js'
import { expandSingleDashFlags, resolveRun } from './context.js'

/**
 * @param {string[]} args
 * @param {{out: {write(s: string): void}, err: {write(s: string): void}}} io
 * @returns {Promise<number>}
 */
export async function runStatus(args, io) {
  const { values } = parseArgs({
    args: expandSingleDashFlags(args, ['tag']),
    options: { C: { type: 'string', default: '.' }, tag: { type: 'string' } },
    allowPositionals: false,
  })

  const run = await resolveRun(values.C, values.tag)
  const baseline = await loadBaseline(join(run.stateDir, BASELINE_FILE))
  const current = await gitx.currentBranch(run.root)
  const rows = await loadRows(join(run.root, RESULTS_PATH))
  const counts = { keep: 0, discard: 0, fail: 0, crash: 0 }
  for (const row of rows) if (row.status in counts) counts[row.status]++

  // A corrupt pid file is an error `evalRunning` deliberately throws rather
  // than guessing at — but a human reaching for `status` to see the REST of
  // the run must never be stopped cold by that. Report the eval line as
  // unreadable and keep going with everything else.
  let evalLine
  try {
    const { pid, running } = await evalRunning(run.stateDir)
    evalLine = running ? `running (pid ${pid}) — an experiment is being measured` : 'idle'
  } catch (err) {
    evalLine = `unknown (${err.message})`
  }
  const stopped = await stopRequested(run.stateDir)

  const field = (name, value) => io.out.write(`${name.padEnd(14)} ${value}\n`)
  field('run tag', run.tag)
  field('branch', `${run.branch}  ${current === run.branch ? '(checked out)' : `(not checked out; on ${current})`}`)
  field('baseline', `${baseline.commit}  (run started here)`)
  field(
    'measuring vs',
    baseline.measureCommit === baseline.commit
      ? `${baseline.measureCommit}  (unchanged — nothing kept yet)`
      : `${baseline.measureCommit}  (advanced past the baseline by earlier KEEPs)`,
  )
  field('worktree', join(run.stateDir, WORKTREE_NAME))
  field(
    'experiments',
    `${rows.length} run  (${counts.keep} keep, ${counts.discard} discard, ${counts.fail} fail, ` +
      `${counts.crash} crash)  — next is #${rows.length + 1}`,
  )
  field('eval', evalLine)
  field('stop', stopped ? 'requested — the agent will end the run after the current experiment' : 'not requested')

  io.out.write('\nto stop after the current experiment:  autor3search-javascript stop\n')
  io.out.write('to stop now, abandoning it:            autor3search-javascript stop --force\n')
  return 0
}
