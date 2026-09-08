/**
 * Runs one experiment and returns a verdict.
 *
 * With --json this prints ONE JSON object to stdout and nothing else. That is
 * a contract program.md's loop depends on: the agent parses stdout directly,
 * so a stray line of progress output would break every run. The subprocess
 * transcript goes to run.log instead, opened by this command itself so the
 * agent never has to redirect stdout (doing so would open a second
 * descriptor on the same path and clobber whichever writes second).
 */
import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { headCommit } from '../gitx.js'
import { RUN_LOG_NAME, evalOnce } from '../pipeline.js'
import { RESULTS_PATH, appendRow, loadRows } from '../results.js'
import { BASELINE_FILE, WORKTREE_NAME, loadBaseline } from '../state/index.js'
import { claimEval } from '../state/lock.js'
import { stopRequested } from '../state/stop.js'
import { REASON, STATUS, exitCode } from '../verdict.js'
import { expandSingleDashFlags, loadRepoConfig, resolveRun } from './context.js'

/**
 * @param {string[]} args
 * @param {{out: {write(s: string): void}, err: {write(s: string): void}}} io
 * @returns {Promise<number>}
 */
export async function runEval(args, io) {
  const { values } = parseArgs({
    args: expandSingleDashFlags(args, ['desc']),
    options: {
      C: { type: 'string', default: '.' },
      json: { type: 'boolean', default: false },
      desc: { type: 'string', default: '' },
      'no-log': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })

  // --json's whole contract is that stdout carries nothing but the verdict.
  // --no-log sends the transcript to stdout instead of run.log. Combining
  // them would interleave subprocess chatter with the JSON object, breaking
  // the one contract this command exists to keep — refuse before anything
  // is claimed or touched.
  if (values.json && values['no-log']) {
    io.err.write('--json and --no-log cannot be combined: --json requires stdout to carry only the verdict\n')
    return 2
  }

  const run = await resolveRun(values.C)
  const cfg = await loadRepoConfig(run.root)
  const baseline = await loadBaseline(join(run.stateDir, BASELINE_FILE))

  let claim
  try {
    claim = await claimEval(run.stateDir)
  } catch (err) {
    io.err.write(`${err.message}\n`)
    return 2
  }

  // An interrupt must not leave Vitest workers running: the runner kills its
  // process groups, and this abort signal is what tells evalOnce's measure
  // phase to do it.
  const controller = new AbortController()
  const onSignal = () => controller.abort()
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  // The transcript goes to run.log by default; --no-log streams it to stdout
  // for a human watching interactively instead (never combined with --json,
  // refused above).
  const logStream = values['no-log'] ? null : createWriteStream(join(run.root, RUN_LOG_NAME), { flags: 'a' })
  // A stream error (e.g. the directory vanishing mid-run) must not crash the
  // process via an unhandled 'error' event; it surfaces as a missing
  // transcript instead, which run.log's absence already makes visible.
  logStream?.on('error', () => {})
  const log = values['no-log'] ? io.out : logStream

  try {
    const { result, measurements } = await evalOnce({
      root: run.root,
      stateDir: run.stateDir,
      cfg,
      baseline,
      log,
      signal: controller.signal,
    })

    const experiment = (await loadRows(join(run.root, RESULTS_PATH))).length + 1
    await appendRow(join(run.root, RESULTS_PATH), {
      commit: await headCommit(run.root).catch(() => 'unknown'),
      score: result.score,
      bestBenchDelta: bestDelta(measurements?.time),
      bytesDelta: bestDelta(measurements?.bytes),
      status: result.status.toLowerCase(),
      description: values.desc,
    })

    const stopped = await stopRequested(run.stateDir)
    const context = buildContext(run, baseline, experiment)

    if (values.json) writeJson(io, result, measurements, stopped, context)
    else writeHuman(io, result, measurements, stopped, context)
    return exitCode(result)
  } catch (err) {
    if (controller.signal.aborted) {
      // ABORTED is not a verdict: nothing was measured, so NO results.tsv row
      // is written. The agent treats it as it would a FAIL.
      const aborted = {
        status: STATUS.ABORTED,
        reason: REASON.STOP_FORCED,
        score: 0,
        message: 'the experiment was interrupted before it could be measured',
        regressions: [],
        warnings: [],
      }
      // Still report whatever is actually pending — an interrupt is not
      // itself evidence that a graceful stop was also requested.
      const stopped = await stopRequested(run.stateDir).catch(() => false)
      const context = buildContext(run, baseline)
      if (values.json) writeJson(io, aborted, null, stopped, context)
      else {
        io.err.write(`ABORTED: ${aborted.message}\n`)
        if (stopped) io.err.write('STOP REQUESTED: end the loop after applying this verdict\n')
      }
      return exitCode(aborted)
    }
    throw err
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await closeLog(logStream)
    await claim.release()
  }
}

/** The run context reported alongside a verdict; experiment is omitted when none was recorded. */
function buildContext(run, baseline, experiment) {
  return {
    tag: run.tag,
    branch: run.branch,
    baseline_commit: baseline.commit,
    measure_commit: baseline.measureCommit,
    worktree: join(run.stateDir, WORKTREE_NAME),
    ...(experiment !== undefined ? { experiment } : {}),
  }
}

/** Flushes and closes the transcript stream, if one was opened. */
async function closeLog(stream) {
  if (!stream) return
  await new Promise((resolve) => stream.end(resolve))
}

function writeJson(io, result, measurements, stopped, run) {
  io.out.write(
    `${JSON.stringify({
      status: result.status,
      reason: result.reason,
      score: result.score,
      message: result.message,
      regressions: result.regressions ?? [],
      warnings: result.warnings ?? [],
      deltas: (measurements?.time ?? []).map(publicDelta),
      bytes: (measurements?.bytes ?? []).map(publicDelta),
      stop_requested: stopped,
      run,
    })}\n`,
  )
}

function writeHuman(io, result, measurements, stopped, run) {
  for (const delta of measurements?.time ?? []) {
    io.out.write(
      `${delta.name}  ${(delta.baseCenter * 1e9).toFixed(0)} -> ${(delta.candCenter * 1e9).toFixed(0)} ns/op  ` +
        `${delta.pctChange >= 0 ? '+' : ''}${delta.pctChange.toFixed(2)}%  p=${delta.p.toFixed(5)}` +
        `${delta.significant ? '' : '  (not significant)'}\n`,
    )
  }
  for (const delta of measurements?.bytes ?? []) {
    io.out.write(
      `${delta.name}  ${delta.baseCenter.toFixed(0)} -> ${delta.candCenter.toFixed(0)} bytes/op  ` +
        `${delta.pctChange >= 0 ? '+' : ''}${delta.pctChange.toFixed(2)}%  (approximate hint, never scored)\n`,
    )
  }
  // Warnings go ABOVE the verdict: they qualify how far it can be read, and a
  // reader who stops at the verdict line must not miss them.
  for (const warning of result.warnings ?? []) io.out.write(`WARNING: ${warning}\n`)
  io.out.write(`VERDICT: ${result.status} (${result.reason}) — ${result.message}\n`)
  if (stopped) io.out.write('STOP REQUESTED: end the loop after applying this verdict\n')
  if (run?.experiment) io.out.write(`experiment ${run.experiment} on ${run.branch}\n`)
}

/** The delta fields the agent and a human need, without internal detail. */
const publicDelta = (d) => ({
  name: d.name,
  unit: d.unit,
  base: d.baseCenter,
  candidate: d.candCenter,
  ratio: d.ratio,
  pct_change: d.pctChange,
  p: d.p,
  significant: d.significant,
})

/** The largest single-benchmark improvement, in percent; 0 when unmeasured. */
function bestDelta(deltas) {
  if (!deltas || deltas.length === 0) return 0
  return Math.min(...deltas.map((d) => d.pctChange))
}
