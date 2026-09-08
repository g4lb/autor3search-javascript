/** Prints the machine-fitness report. Always exits 0 — it informs, never blocks. */
import { parseArgs } from 'node:util'
import { SEVERITY, check } from '../doctor.js'

const LABEL = { [SEVERITY.OK]: 'ok  ', [SEVERITY.WARN]: 'warn', [SEVERITY.FAIL]: 'FAIL', [SEVERITY.NA]: 'n/a ' }

/**
 * @param {string[]} args
 * @param {{out: {write(s: string): void}, err: {write(s: string): void}}} io
 * @returns {Promise<number>}
 */
export async function runDoctor(args, io) {
  const { values } = parseArgs({
    args,
    options: { C: { type: 'string', default: '.' } },
    allowPositionals: false,
  })

  const findings = await check(values.C)
  for (const f of findings) io.out.write(`${LABEL[f.severity]}  ${f.name.padEnd(14)} ${f.detail}\n`)

  const failures = findings.filter((f) => f.severity === SEVERITY.FAIL).length
  const warnings = findings.filter((f) => f.severity === SEVERITY.WARN).length
  io.out.write('\n')
  if (failures > 0) {
    io.out.write(`${failures} problem(s) will stop a run from working at all — fix those first.\n`)
  } else if (warnings > 0) {
    io.out.write(
      `${warnings} warning(s): this machine can measure, but expect noisier numbers. Raise min_effect_pct\n` +
        `if experiments look erratic — it costs you only wins smaller than the noise you cannot measure anyway.\n`,
    )
  } else {
    io.out.write('this machine looks fit to measure.\n')
  }
  // Deliberately 0 regardless: whether to accept a noisy machine is the
  // human's decision, not the harness's.
  return 0
}
