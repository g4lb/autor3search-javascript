/**
 * Runs one full evaluation: gate correctness, measure the candidate against
 * the pinned baseline, score it.
 *
 * It lives here rather than in the command layer so it is testable without a
 * process boundary — `eval` itself handles only flags, output formatting and
 * the exit code.
 *
 * CONTRACT: evalOnce RETURNS a terminal verdict for every gate outcome and
 * every completed measurement. A THROWN error means the harness itself
 * malfunctioned (I/O, git, a malformed baseline), never that the candidate
 * was rejected. Callers treat those two cases completely differently.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CONFIG_PATH } from './config.js'
import { UNIT_BYTES, UNIT_TIME } from './bench/set.js'
import { compareAll, geoMean } from './bench/stats.js'
import { benchFiles, frozenFiles } from './discover.js'
import * as freeze from './freeze.js'
import * as gitx from './gitx.js'
import { measure } from './measure.js'
import { RESULTS_PATH } from './results.js'
import { runGates } from './adapters/gates/index.js'
import { createMatcher } from './scope.js'
import { WORKTREE_NAME, BASELINE_FILE, saveBaseline } from './state/index.js'
import { REASON, STATUS, decide, gate } from './verdict.js'
import { parseDuration } from './duration.js'

/**
 * The harness-owned scratch log inside the repository root. Subprocess output
 * that would otherwise flood an unattended agent's context is written here
 * rather than to stdout. `init` gitignores it, and it is not part of the score.
 */
export const RUN_LOG_NAME = 'run.log'

/**
 * Files whose modification is rejected regardless of scope. Changing a
 * dependency is a supply-chain decision a human makes, not something an
 * unattended overnight loop decides — and a swapped dependency changes WHAT
 * is measured, not just how fast it runs. The default scope matches root
 * files, so this cannot be left to the scope patterns.
 */
export const DEPENDENCY_FILES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
])

/** Which gate failure maps to which status and reason. */
const GATE_VERDICT = {
  typecheck: { status: STATUS.CRASH, reason: REASON.TYPECHECK },
  lint: { status: STATUS.FAIL, reason: REASON.LINT },
  test: { status: STATUS.FAIL, reason: REASON.TESTS },
}

/**
 * @param {{root: string, stateDir: string, cfg: object, baseline: object, log?: object, signal?: AbortSignal}} o
 * @returns {Promise<{result: object, measurements: {time: object[], bytes: object[]|null}|null}>}
 */
export async function evalOnce(o) {
  const timeoutMs = parseDuration(o.cfg.timeout)

  // ---- 1. Scope --------------------------------------------------------
  // Checked before anything is restored or built, so an out-of-scope edit is
  // reported as itself rather than as a build error.
  //
  // Deliberately diffs against baseline.commit — the FROZEN, never-advancing
  // anchor — and NOT measureCommit, which moves after every KEEP. Anchoring
  // here means the gate re-validates the FULL accumulated diff on every eval.
  // Anchoring it to the advancing pointer instead would give an out-of-scope
  // edit exactly one eval in which to be caught: past that single check it
  // would become part of the "already accepted" state and never be looked at
  // again.
  const changed = await gitx.changedSince(o.root, o.baseline.commit)
  const matcher = createMatcher(o.cfg.scope)
  const frozenSet = new Set(await frozenFiles(o.root, o.cfg.unfreeze))

  for (const rel of changed) {
    if (DEPENDENCY_FILES.has(rel)) {
      return terminal(
        gate(
          STATUS.FAIL,
          REASON.SCOPE,
          `${rel} may not be modified: dependency changes are a human decision, not an autonomous one`,
        ),
      )
    }
    // Harness output, plus the human-owned config, which is integrity-checked
    // below rather than scope-checked.
    if (rel === RESULTS_PATH || rel === RUN_LOG_NAME || rel === CONFIG_PATH) continue
    // Frozen files are handled by restore, not by the scope gate.
    if (frozenSet.has(rel)) continue
    if (!matcher.match(rel)) {
      return terminal(
        gate(STATUS.FAIL, REASON.SCOPE, `${rel} is outside the allowed scope ${JSON.stringify(o.cfg.scope)}`),
      )
    }
  }

  // ---- 1b. Config integrity -------------------------------------------
  // config.yaml lives in the repo because humans own it, which means the
  // agent can reach it. Raising max_regress_pct or deleting entries from the
  // benchmark set would defeat the guard, so the file is hashed at baseline
  // and any change fails the run.
  const configSha = await sha256File(join(o.root, CONFIG_PATH))
  if (configSha !== o.baseline.configSha256) {
    return terminal(
      gate(
        STATUS.FAIL,
        REASON.CONFIG_CHANGED,
        `${CONFIG_PATH} changed since baseline — scoring rules are fixed for a run; revert it, or start ` +
          `a new run with 'autor3search-javascript baseline'`,
      ),
    )
  }

  // ---- 2. Restore frozen tests and benchmarks --------------------------
  const manifest = await freeze.loadManifest(join(o.stateDir, freeze.MANIFEST_PATH))
  let restored
  try {
    restored = await freeze.restore(o.root, join(o.stateDir, freeze.STORE_DIR), manifest)
  } catch (err) {
    // A frozen file replaced by a symlink or a hard link is TAMPERING, not a
    // harness malfunction: report it as a verdict so the run gets a
    // results.tsv row and an actionable message, rather than aborting with no
    // signal at all.
    if (err.code === freeze.ERR_HARD_LINK) {
      return terminal(
        gate(
          STATUS.FAIL,
          REASON.HARDLINK_SWAP,
          `${err.message} — a frozen file must have exactly one name; a hard link would let a restore ` +
            `write outside the repository`,
        ),
      )
    }
    if (err.code === freeze.ERR_SYMLINK) {
      return terminal(
        gate(
          STATUS.FAIL,
          REASON.SYMLINK_SWAP,
          `${err.message} — a frozen file, and every directory on the way to it, must remain a regular ` +
            `file and real directories; restore them and rerun`,
        ),
      )
    }
    // A golden copy that no longer matches its recorded hash means the store
    // itself was rewritten. Unlike a symlink this cannot be undone by fixing
    // the working tree, because the reference copy is the thing that was lost.
    if (err.code === freeze.ERR_STORE_TAMPERED) {
      return terminal(
        gate(
          STATUS.FAIL,
          REASON.FROZEN_TAMPERED,
          `${err.message} — the frozen copy this run scores against was modified, so its tests can no ` +
            `longer be trusted. Start a fresh run with 'autor3search-javascript baseline'.`,
        ),
      )
    }
    throw err
  }
  if (restored.length > 0) {
    o.log?.write(`restored ${restored.length} frozen file(s): ${restored.join(', ')}\n`)
  }

  // ---- 2b. Frozen-set integrity, in BOTH directions --------------------
  // Restore only rewrites files it froze, and the scope gate skips every
  // frozen path, so without this an agent could ADD a brand-new test or bench
  // file — an easier benchmark, or one shadowing a frozen one — and neither
  // gate would notice.
  //
  // The reverse direction matters just as much and is easier to miss: a file
  // restore just rewrote should always be visible to the walker again, so a
  // manifest entry MISSING from what is present means the walk could not
  // reach it. A structural change to the tree can hide a frozen file from
  // discovery while leaving it nominally restored, and the run would then
  // score against a benchmark set that no longer runs.
  const present = new Set(await frozenFiles(o.root, o.cfg.unfreeze))
  const added = [...present].filter((rel) => !(rel in manifest.files)).sort()
  if (added.length > 0) {
    return terminal(
      gate(
        STATUS.FAIL,
        REASON.NEW_TEST_FILE,
        `test or benchmark files not present at baseline: ${added.join(', ')} — the benchmark set is ` +
          `frozen; add them before running 'autor3search-javascript baseline', or list them in config unfreeze`,
      ),
    )
  }
  const missing = Object.keys(manifest.files).filter((rel) => !present.has(rel)).sort()
  if (missing.length > 0) {
    return terminal(
      gate(
        STATUS.FAIL,
        REASON.MISSING_TEST_FILE,
        `frozen files are no longer discoverable in the working tree: ${missing.join(', ')} — they were ` +
          `restored, but the walk that finds them cannot reach them, so they would not run. Check for a ` +
          `directory on their path that was replaced, renamed, or moved under a skipped name.`,
      ),
    )
  }

  // ---- 3-5. Correctness gates -----------------------------------------
  const outcomes = await runGates(o.root, {
    modes: o.cfg.gates,
    scope: o.cfg.scope,
    timeoutMs,
    log: o.log,
    signal: o.signal,
  })
  // An abort during the gate phase is an ABORT, not a gate failure. Without
  // this the killed subprocess would look like a failing test, producing a
  // FAIL verdict and a results.tsv row for an experiment nobody measured.
  if (o.signal?.aborted) throw new Error('aborted during the correctness gates')
  for (const outcome of outcomes) {
    if (outcome.skipped) o.log?.write(`gate ${outcome.name} skipped: ${outcome.skipped}\n`)
    if (outcome.ok) continue
    if (outcome.timedOut) {
      return terminal(gate(STATUS.CRASH, REASON.TIMEOUT, `${outcome.name} gate timed out after ${o.cfg.timeout}`))
    }
    const { status, reason } = GATE_VERDICT[outcome.name]
    return terminal(gate(status, reason, outcome.detail))
  }

  // ---- 5b. Baseline worktree integrity --------------------------------
  // An agent could edit the pinned baseline worktree in place to make the
  // BASELINE slow, after which every candidate "improves" and every
  // experiment returns KEEP without optimizing anything.
  //
  // Compares against measureCommit, not commit: the worktree is re-pointed
  // after every KEEP, so comparing against the frozen anchor would fire
  // spuriously on the very next eval after any KEEP.
  //
  // This is a DETECTION, and only a partial one. The state directory lives
  // outside the repository, but the agent runs as the same OS user, so
  // nothing stops it editing the worktree in place — this catches that only
  // if HEAD itself moves. Treat it as catching accidental clobbering and a
  // careless tamper, not as a guarantee.
  const worktreeDir = join(o.stateDir, WORKTREE_NAME)
  const worktreeHead = await gitx.headCommit(worktreeDir)
  if (worktreeHead !== o.baseline.measureCommit) {
    return terminal(
      gate(
        STATUS.FAIL,
        REASON.BASELINE_TAMPERED,
        `pinned baseline worktree HEAD is ${worktreeHead} but the recorded measurement commit is ` +
          `${o.baseline.measureCommit} — the worktree no longer matches the baseline and this run's ` +
          `measurements cannot be trusted. Start a fresh run with 'autor3search-javascript baseline'.`,
      ),
    )
  }

  // ---- 6. Measure ------------------------------------------------------
  let baseSet, candSet
  try {
    ;({ baseSet, candSet } = await measure({
      runner: o.cfg.runner,
      baseDir: worktreeDir,
      candDir: o.root,
      benchmarks: o.baseline.benchmarks,
      rounds: o.cfg.count,
      warmup: true,
      timeoutMs,
      heapHint: o.cfg.heapHint,
      benchFiles: await benchFiles(o.root),
      log: o.log,
      signal: o.signal,
    }))
  } catch (err) {
    // An ABORT is not a measurement failure. The bench adapter reports an
    // aborted round as a timeout (both set `timedOut` on the runner result),
    // so without this check a human pressing Ctrl+C or running `stop --force`
    // would get CRASH/measurement_failed instead of ABORTED — and a
    // results.tsv row would be written for an experiment that was never
    // measured. Rethrow so the command layer's abort handler owns it.
    if (o.signal?.aborted) throw err
    return terminal(gate(STATUS.CRASH, REASON.MEASUREMENT, err.message))
  }

  // ---- 7. Score --------------------------------------------------------
  // Time is the scored metric: any failure here — including a benchmark that
  // vanished from the candidate — fails the whole call, per compareAll's
  // contract.
  const timeDeltas = compareAll(baseSet, candSet, UNIT_TIME)
  const score = geoMean(timeDeltas)

  // The bytes hint is informational ONLY. compareAll is strict about a
  // benchmark disappearing from one side, which is right for the scored
  // metric and wrong here: a hint that could not be measured must never fail
  // a real, correctly-measured experiment.
  let bytesDeltas = null
  try {
    bytesDeltas = compareAll(baseSet, candSet, UNIT_BYTES)
  } catch (err) {
    o.log?.write(`bytes/op comparison unavailable, continuing without it: ${err.message}\n`)
  }

  const result = decide({
    deltas: timeDeltas,
    score,
    maxRegressPct: o.cfg.maxRegressPct,
    minEffectPct: o.cfg.minEffectPct,
  })

  // ---- 8. Advance the measurement baseline on KEEP ---------------------
  // Without this, every experiment after the first kept one is measured
  // against the run's ORIGINAL commit forever, so a later no-op that merely
  // fails to regress an EARLIER improvement still banks as KEEP.
  if (result.status === STATUS.KEEP) {
    await advanceMeasurementBaseline(o, worktreeDir)
  }

  return { result, measurements: { time: timeDeltas, bytes: bytesDeltas } }
}

/**
 * Re-points the pinned baseline worktree at the candidate's own commit and
 * persists it as the new measureCommit.
 *
 * A failure here is thrown, not folded into the verdict: continuing to run
 * experiments against a worktree that no longer agrees with the recorded
 * measurement commit would silently corrupt every subsequent measurement —
 * exactly the class of bug this advance exists to fix. Should it fail after
 * the worktree moved but before the new commit was persisted, the NEXT eval's
 * worktree-integrity check catches the mismatch and fails loudly.
 */
async function advanceMeasurementBaseline(o, worktreeDir) {
  const newCommit = await gitx.headCommit(o.root)
  await gitx.checkoutDetached(worktreeDir, newCommit)
  o.baseline.measureCommit = newCommit
  await saveBaseline(join(o.stateDir, BASELINE_FILE), o.baseline)
}

const terminal = (result) => ({ result, measurements: null })

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}
