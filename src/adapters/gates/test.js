/**
 * The test gate. Correctness is never traded for speed: this runs the frozen
 * tests, which were restored moments earlier, so a candidate that broke
 * behaviour fails here before anything is measured.
 */
import { Runner } from '../../runner.js'
import { resolveFrom } from './util.js'

export const name = 'test'

export async function unavailable(dir) {
  return resolveFrom(dir, 'vitest/vitest.mjs') ? null : 'vitest is not installed in this repository'
}

export async function run(dir, opts) {
  const bin = resolveFrom(dir, 'vitest/vitest.mjs')
  const result = await new Runner(dir, opts.timeoutMs, opts.log).run(process.execPath, [bin, 'run'])
  return {
    ran: true,
    ok: result.ok(),
    timedOut: result.timedOut,
    skipped: null,
    detail: result.ok() ? 'vitest run' : result.tail(40),
  }
}
