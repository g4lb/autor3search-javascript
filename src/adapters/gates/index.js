/**
 * Runs the correctness gates in order, stopping at the first failure.
 *
 * Stopping early is deliberate: once a gate has rejected the candidate the
 * experiment is over, and running the rest would spend minutes producing
 * output nobody will read.
 */
import * as typecheck from './typecheck.js'
import * as lint from './lint.js'
import * as test from './test.js'

/** Order matters: cheapest and most fundamental first. */
const GATES = [typecheck, lint, test]

/**
 * @param {string} dir
 * @param {{modes: Record<string,string>, scope: string[], timeoutMs: number, log?: object, signal?: AbortSignal}} opts
 * @returns {Promise<{name: string, ran: boolean, ok: boolean, timedOut: boolean, skipped: string|null, detail: string}[]>}
 */
export async function runGates(dir, opts) {
  const outcomes = []
  for (const gate of GATES) {
    const mode = opts.modes?.[gate.name] ?? 'auto'
    if (mode === 'off') {
      outcomes.push(skip(gate.name, 'gates.' + gate.name + ' is "off"'))
      continue
    }

    const why = await gate.unavailable(dir)
    if (why) {
      if (mode === 'on') {
        // A gate the user explicitly asked for must not silently vanish.
        outcomes.push({
          name: gate.name,
          ran: false,
          ok: false,
          timedOut: false,
          skipped: null,
          detail: `gates.${gate.name} is "on" but the gate cannot run: ${why}`,
        })
        return outcomes
      }
      outcomes.push(skip(gate.name, why))
      continue
    }

    const outcome = { name: gate.name, ...(await gate.run(dir, opts)) }
    // Stop early if the caller aborted while this gate ran; the remaining
    // gates would only spend minutes producing output nobody will read.
    if (opts.signal?.aborted) return outcomes.concat(outcome)
    // A gate that ran but only in a WEAKER form than the repository calls for
    // fails when the user required it. Silently giving someone a lesser check
    // than they asked for is the same defect as skipping it, but harder to notice.
    if (mode === 'on' && outcome.degraded && outcome.ok) {
      outcome.ok = false
      outcome.detail = `gates.${gate.name} is "on" but only a degraded check was possible: ${outcome.detail}`
    }
    outcomes.push(outcome)
    if (!outcome.ok) return outcomes
  }
  return outcomes
}

const skip = (name, why) => ({ name, ran: false, ok: true, timedOut: false, skipped: why, detail: '' })
