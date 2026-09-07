/**
 * Turns gate outcomes and measurements into a single decision.
 *
 * This module is the contract with the agent: program.md documents these
 * status strings, these reason codes and these exit codes, and the agent's
 * loop branches on them. They are frozen — renaming one is a breaking change
 * to templates/program.md and must happen in the same commit.
 */
import { countForAlpha, minAchievableP } from './bench/stats.js'

/** The terminal outcomes of one experiment. */
export const STATUS = {
  KEEP: 'KEEP',
  DISCARD: 'DISCARD',
  FAIL: 'FAIL',
  CRASH: 'CRASH',
  /** Not a verdict: an experiment interrupted before it was measured. */
  ABORTED: 'ABORTED',
}

/** Machine-readable explanations, grouped by the stage that produces them. */
export const REASON = {
  IMPROVED: 'improved',
  NO_IMPROVEMENT: 'no_significant_improvement',
  BELOW_MIN_EFFECT: 'improvement_below_min_effect',
  GUARD_REGRESSION: 'guard_regression',
  SCOPE: 'scope_violation',
  CONFIG_CHANGED: 'config_changed',
  NEW_TEST_FILE: 'new_test_file',
  MISSING_TEST_FILE: 'missing_test_file',
  SYMLINK_SWAP: 'symlink_swap',
  FROZEN_TAMPERED: 'frozen_store_tampered',
  BASELINE_TAMPERED: 'baseline_tampered',
  TYPECHECK: 'typecheck_failed',
  LINT: 'lint_failed',
  /** The benchmark run itself failed, so there is nothing to score. */
  MEASUREMENT: 'measurement_failed',
  TESTS: 'tests_failed',
  TIMEOUT: 'timeout',
  STOP_FORCED: 'stop_forced',
}

/**
 * Builds a Result for a failed correctness stage, before measurement.
 *
 * @param {string} status
 * @param {string} reason
 * @param {string} message
 */
export function gate(status, reason, message) {
  return { status, reason, score: 0, message, regressions: [], warnings: [] }
}

/**
 * Applies the scoring rules.
 *
 * 1. Any regression significant at the RAW, uncorrected alpha and larger than
 *    maxRegressPct rejects the change, however good the overall score. This
 *    check deliberately does not apply the Bonferroni correction from rule 2:
 *    Bonferroni only ever makes it harder to call a result significant, and
 *    applying it here would make the guard LESS sensitive to harm — backwards
 *    from what a guard is for. The asymmetry is intentional: be conservative
 *    about accepting a win, be liberal about catching a regression.
 *
 * 2. Otherwise keep only when BOTH:
 *    a. the score is a real speedup by at least minEffectPct — below
 *       1 - minEffectPct/100, not merely below 1. A result that is
 *       technically significant but trivially small is not worth a commit in
 *       an unattended loop.
 *    b. at least one benchmark improved at the Bonferroni-corrected
 *       threshold alpha/k, where k is the number of benchmarks compared.
 *       Comparing k benchmarks against the same uncorrected alpha inflates
 *       the family-wise false-positive rate — with k = 4, roughly an 18%
 *       chance at least one shows a spurious "significant" improvement even
 *       when nothing changed.
 *
 * A change clearing 2b but missing 2a discards with BELOW_MIN_EFFECT rather
 * than NO_IMPROVEMENT: it measurably worked, it was just too small to bank,
 * and those call for different next moves.
 *
 * @param {{deltas: object[], score: number, maxRegressPct: number, minEffectPct: number}} input
 */
export function decide(input) {
  const deltas = input.deltas ?? []
  // k is the family size for the Bonferroni correction. compareAll never
  // returns an empty list, but guard against division by zero anyway.
  const k = Math.max(1, deltas.length)
  const warnings = measurementWarnings(deltas, k)
  const score = input.score

  const regressions = deltas.filter((d) => d.significant && d.pctChange > input.maxRegressPct)
  if (regressions.length > 0) {
    const detail = regressions.map((d) => `${d.name} ${signed(d.pctChange, 1)}%`).join(', ')
    return {
      status: STATUS.DISCARD,
      reason: REASON.GUARD_REGRESSION,
      score,
      message: `regression guard tripped (limit ${signed(input.maxRegressPct, 1)}%): ${detail}`,
      regressions,
      warnings,
    }
  }

  const improved = deltas.some((d) => d.pctChange < 0 && d.p < d.alpha / k)
  const minEffectThreshold = 1 - input.minEffectPct / 100

  if (score < minEffectThreshold && improved) {
    return {
      status: STATUS.KEEP,
      reason: REASON.IMPROVED,
      score,
      message: `score ${score.toFixed(4)} (${signed((score - 1) * 100, 2)}%)`,
      regressions: [],
      warnings,
    }
  }

  if (improved && score < 1) {
    return {
      status: STATUS.DISCARD,
      reason: REASON.BELOW_MIN_EFFECT,
      score,
      message:
        `score ${score.toFixed(4)} (${signed((score - 1) * 100, 2)}%), a real improvement but below ` +
        `the ${input.minEffectPct.toFixed(1)}% minimum effect size`,
      regressions: [],
      warnings,
    }
  }

  return {
    status: STATUS.DISCARD,
    reason: REASON.NO_IMPROVEMENT,
    score,
    message: `score ${score.toFixed(4)} (${signed((score - 1) * 100, 2)}%), no significant improvement`,
    regressions: [],
    warnings,
  }
}

/**
 * Gathers everything that qualifies how far the numbers in a Result can be
 * trusted: each comparison's own warnings, then the check that a KEEP was
 * statistically reachable at all. These never change the decision — they say
 * what it can and cannot mean.
 */
function measurementWarnings(deltas, k) {
  const out = [...new Set(deltas.flatMap((d) => d.warnings ?? []))]
  const unreachable = unreachableAlphaWarning(deltas, k)
  if (unreachable) out.push(unreachable)
  return out
}

/**
 * Reports when rule 2b cannot be satisfied by any result whatsoever, so the
 * run is incapable of a KEEP before it starts.
 *
 * config.validate enforces a count floor for a single benchmark; this is the
 * same footgun at k benchmarks, which the validator cannot see because it does
 * not know how many benchmarks a run will compare. A KEEP needs only ONE
 * benchmark to clear the threshold, so this warns only when none of them can.
 */
function unreachableAlphaWarning(deltas, k) {
  if (deltas.length === 0) return null
  let worstN = 0
  let alpha = 0
  for (const d of deltas) {
    const corrected = d.alpha / k
    // This one can clear it; that is enough for a KEEP to be possible.
    if (minAchievableP(d.nBase, d.nCand) < corrected) return null
    const n = Math.min(d.nBase, d.nCand)
    if (n > worstN) {
      worstN = n
      alpha = d.alpha
    }
  }
  const corrected = alpha / k
  const need = countForAlpha(corrected)
  const tail = need > 0 ? ` — raise count to at least ${need}` : ' — raise count, or measure fewer benchmarks'
  return (
    `no KEEP was reachable: comparing ${k} benchmark(s) corrects the significance threshold to ` +
    `${corrected.toFixed(5)}, but with ${worstN} rounds per side the test cannot produce a p-value ` +
    `below ${minAchievableP(worstN, worstN).toFixed(5)} however large the improvement is${tail}`
  )
}

/**
 * Maps a Result to the process exit code program.md documents.
 *
 * Anything unrecognised — including ABORTED, which is an interrupted
 * experiment rather than a verdict — maps to FAIL. Never to 0: a status the
 * harness cannot classify must not read to the agent as a successful KEEP.
 *
 * @param {{status: string}} result
 * @returns {number}
 */
export function exitCode(result) {
  switch (result.status) {
    case STATUS.KEEP:
      return 0
    case STATUS.DISCARD:
      return 1
    case STATUS.CRASH:
      return 3
    default:
      return 2
  }
}

/** Formats a number with an explicit sign, e.g. "+12.0", "-8.77". */
function signed(n, digits) {
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}`
}
