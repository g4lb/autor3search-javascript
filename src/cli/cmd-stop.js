/**
 * Asks the agent to end the run.
 *
 * Plain `stop` is the one to use: it writes a request `eval` reports back, so
 * the experiment under way finishes and is scored, its verdict is applied,
 * and only then does the loop exit. Nothing is thrown away.
 *
 * `--force` is for when a long benchmark cannot be waited out. It writes the
 * same request, then signals the running eval to abandon the experiment. It
 * REPORTS what state that leaves the repository in; it does not drop anything
 * for you, because deciding what to do with a half-finished experiment is the
 * human's call.
 */
import { parseArgs } from 'node:util'
import * as gitx from '../gitx.js'
import { evalRunning } from '../state/lock.js'
import { clearStop, requestStop } from '../state/stop.js'
import { expandSingleDashFlags, resolveRun } from './context.js'

/**
 * @param {string[]} args
 * @param {{out: {write(s: string): void}, err: {write(s: string): void}}} io
 * @returns {Promise<number>}
 */
export async function runStop(args, io) {
  const { values } = parseArgs({
    args: expandSingleDashFlags(args, ['tag']),
    options: {
      C: { type: 'string', default: '.' },
      tag: { type: 'string' },
      clear: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })

  if (values.clear && values.force) {
    io.err.write('--clear and --force ask for opposite things; pass one or the other\n')
    return 2
  }

  const run = await resolveRun(values.C, values.tag)

  if (values.clear) {
    await clearStop(run.stateDir)
    io.out.write(`stop request for ${run.tag} cancelled — the loop may continue\n`)
    return 0
  }

  await requestStop(run.stateDir)
  io.out.write(`stop requested for ${run.tag}: the agent will end the run after the current experiment\n`)
  if (!values.force) {
    io.out.write('the experiment under way will still be measured, scored and applied\n')
    io.out.write(`to cancel: autor3search-javascript stop -tag ${run.tag} --clear\n`)
    return 0
  }

  // A corrupt pid file must not crash `stop --force` — it is refused by
  // evalRunning rather than guessed at, but the request above already stands
  // regardless, so fall back to "nothing known to signal" and keep going.
  let pid = null
  let running = false
  try {
    ;({ pid, running } = await evalRunning(run.stateDir))
  } catch (err) {
    io.err.write(`could not read the eval lock (${err.message}); assuming there is nothing to signal\n`)
  }

  if (running) {
    // SIGTERM, not SIGKILL: eval installs a handler that tears down its child
    // process groups. Killing it outright would leave Vitest workers running,
    // burning CPU and corrupting every later measurement on this machine.
    try {
      process.kill(pid, 'SIGTERM')
      io.out.write(`signalled eval (pid ${pid}) to abandon the current experiment\n`)
    } catch (err) {
      io.err.write(`could not signal eval (pid ${pid}): ${err.message}\n`)
    }
  } else {
    io.out.write('no eval is running, so there was nothing to interrupt — the request stands\n')
  }

  // Report, do not act — whether or not anything was actually interrupted,
  // this is what the repository looks like right now. The commit an
  // abandoned experiment made, if any, is still on the branch and nothing
  // scored it; dropping it is the human's call, not this command's.
  const branch = await gitx.currentBranch(run.root).catch(() => 'unknown')
  const head = await gitx.headCommit(run.root).catch(() => 'unknown')
  const subject = await gitx.headSubject(run.root).catch(() => '')
  io.out.write('\nwhat this leaves you with:\n')
  io.out.write(`  branch    ${branch}\n`)
  io.out.write(`  HEAD      ${head}  ${subject}\n`)
  io.out.write('  no results.tsv row is written for an experiment interrupted this way\n')
  io.out.write('\nHEAD may be the commit for an experiment nothing scored. If it is, drop it yourself:\n')
  io.out.write('  git reset --hard HEAD~1\n')
  io.out.write('Every commit kept before it is untouched.\n')
  return 0
}
