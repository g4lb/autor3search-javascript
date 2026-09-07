/**
 * The Vitest implementation of the BenchRunner interface.
 *
 * One call to run() is ONE MEASURED ROUND: a single `vitest bench` process
 * invocation, contributing one observation per benchmark. Rounds are what the
 * significance test counts, so this must never be asked to loop internally.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseVitestBench } from '../../bench/parse.js'
import { Runner } from '../../runner.js'

/**
 * Runs one measured round.
 *
 * The report is written to a temp file via --outputJson rather than parsed
 * from stdout: Vitest interleaves progress output with the report, and a
 * stray console.log from the measured code would corrupt a stdout parse.
 *
 * @param {string} dir the worktree to measure
 * @param {{benchmarks?: string[], timeoutMs: number, env?: object, log?: {write(s: string): void}, signal?: AbortSignal}} opts
 *   `benchmarks` selects the declared set AFTER parsing. Vitest has no working
 *   benchmark name filter — `--testNamePattern` is accepted but does not filter
 *   benches (confirmed against Vitest 2.1.9: `^(alpha)$` still returns `beta`
 *   too) — so selection happens here rather than on the command line.
 * @returns {Promise<import('../../bench/set.js').BenchSet>}
 */
async function run(dir, opts) {
  const scratch = await mkdtemp(join(tmpdir(), 'a3s-bench-'))
  const reportPath = join(scratch, 'bench.json')
  try {
    const runner = new Runner(dir, opts.timeoutMs, opts.log ?? null)
    const result = await runner.run(
      process.execPath,
      [
        vitestBin(dir),
        'bench',
        '--run',
        // `--outputJson` is the ONLY working way to get a machine-readable
        // benchmark report. `--reporter=json --outputFile=…` fails outright
        // ("Failed to load custom Reporter from json") and writes nothing.
        // There is no `--benchmark.time=…` flag either; `BenchmarkUserOptions`
        // exposes only include/exclude/includeSource/reporters/outputFile/
        // compare/outputJson/includeSamples.
        `--outputJson=${reportPath}`,
        `--root=${dir}`,
      ],
      { env: opts.env ?? process.env, signal: opts.signal },
    )

    if (result.timedOut) {
      throw new Error(`benchmark round timed out in ${dir}`)
    }

    // A non-zero exit means some task (an import, a bench body) blew up. The
    // JSON report may still exist in this case — Vitest writes it with an
    // empty `groups` array for the failed file — but it cannot be trusted as
    // a complete measurement, and the excerpt naming the real failure lives
    // in the process output, not in the report. So this is checked BEFORE
    // reading the report, not after, and carries the tail with it.
    if (!result.ok()) {
      throw new Error(`bench run failed in ${dir} (exit ${result.exitCode}):\n${result.tail(30)}`)
    }

    const report = await readFile(reportPath, 'utf8').catch(() => null)
    if (report === null) {
      throw new Error(
        `bench run exited cleanly in ${dir} but wrote no report at ${reportPath}:\n${result.tail(30)}`,
      )
    }

    let parsed
    try {
      parsed = parseVitestBench(report)
    } catch (err) {
      if (/contained no benchmarks/.test(err.message)) {
        throw new Error(`Vitest measured no benchmarks at all in ${dir}: ${err.message}`, { cause: err })
      }
      throw err
    }

    // Selection happens HERE, not on the command line: Vitest accepts
    // --testNamePattern for benches but does not act on it, so a run measures
    // everything and the declared set is chosen afterwards. Costs wall-clock
    // on undeclared benchmarks; correctness first.
    const declared = opts.benchmarks ?? []
    const set = parsed.selectByBase(declared)
    if (set.names().length === 0) {
      throw new Error(
        `no benchmarks matched ${JSON.stringify(declared)} in ${dir} (measured: ${JSON.stringify(parsed.bases())})`,
      )
    }
    return set
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** The Vitest CLI entry point inside the measured repository. */
function vitestBin(dir) {
  return join(dir, 'node_modules', 'vitest', 'vitest.mjs')
}

/** @type {{name: string, run: typeof run}} */
export const vitestRunner = { name: 'vitest', run }
