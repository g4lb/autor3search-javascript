/**
 * Summarizes results.tsv: what ran, what was kept, and how much faster.
 *
 * Cumulative speedup is the PRODUCT of every kept score, never the latest
 * score and never an average. The harness re-points its measurement baseline
 * at the commit just kept after every KEEP, so each kept `score` measures
 * only that experiment's own incremental contribution — "did this change
 * help, compared to the last thing we kept" — never "is the tree better than
 * when the run started". Successive improvements compound the way
 * percentage changes do, so multiplying is the only way to recover total
 * progress; averaging or taking the last score would both understate a good
 * night, in different ways.
 *
 * A DISCARD's score is real (it was measured) but was rejected, so it is
 * excluded from the product — folding it in would invent progress that was
 * explicitly not banked.
 */
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { RESULTS_PATH, loadRows } from '../results.js'
import { resolveRepo } from './context.js'

/** How many of the largest wins to list. */
const TOP_N = 5

/** Every status appendRow may write, in the order counted and printed. */
const STATUSES = ['keep', 'discard', 'fail', 'crash']

/**
 * @param {string[]} args
 * @param {{out: {write(s: string): void}, err: {write(s: string): void}}} io
 * @returns {Promise<number>}
 */
export async function runReport(args, io) {
  const { values } = parseArgs({
    args,
    options: { C: { type: 'string', default: '.' } },
    allowPositionals: false,
  })
  const root = await resolveRepo(values.C)
  const rows = await loadRows(join(root, RESULTS_PATH))

  if (rows.length === 0) {
    io.out.write(`no experiments recorded in ${RESULTS_PATH} yet — nothing to report\n`)
    return 0
  }

  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]))
  let other = 0
  for (const row of rows) {
    if (Object.hasOwn(counts, row.status)) counts[row.status]++
    else other++
  }

  io.out.write('experiments\n')
  for (const status of STATUSES) io.out.write(`  ${status.padEnd(10)} ${counts[status]}\n`)
  if (other > 0) io.out.write(`  ${'other'.padEnd(10)} ${other}  (unrecognised status)\n`)
  io.out.write(`  ${'total'.padEnd(10)} ${rows.length}\n\n`)

  const kept = rows.filter((r) => r.status === 'keep')
  if (kept.length === 0) {
    io.out.write('nothing was kept — no measured improvement cleared the bar.\n')
    return 0
  }

  // The PRODUCT of every kept score — see file header for why.
  const cumulative = kept.reduce((acc, r) => acc * r.score, 1)
  io.out.write(`cumulative speedup   ${cumulative.toFixed(4)}  (${formatMultiplier(cumulative)}, `)
  io.out.write(`${formatPercent(cumulative)})\n`)
  io.out.write(`  the product of all ${kept.length} kept score(s); discards do not contribute\n\n`)

  io.out.write('largest individual wins\n')
  for (const row of [...kept].sort((a, b) => a.score - b.score).slice(0, TOP_N)) {
    io.out.write(
      `  ${row.commit.padEnd(9)} ${row.score.toFixed(4)}  ` +
        `${row.bestBenchDelta >= 0 ? '+' : ''}${row.bestBenchDelta.toFixed(1)}%  ${row.description}\n`,
    )
  }
  return 0
}

/**
 * The cumulative ratio as a human-readable "Nx faster". A ratio of exactly
 * zero (a kept experiment measured at effectively zero cost) has no finite
 * reciprocal — report that plainly instead of printing "Infinityx".
 */
function formatMultiplier(cumulative) {
  if (cumulative <= 0) return 'immeasurably faster (measured cost of zero)'
  return `${(1 / cumulative).toFixed(2)}x faster`
}

/** The cumulative ratio as a signed percent change, e.g. "-75.00%". */
function formatPercent(cumulative) {
  const pct = (cumulative - 1) * 100
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`
}
