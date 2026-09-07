/** The lint gate: ESLint, when the repository is configured for it. */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Runner } from '../../runner.js'
import { resolveFrom } from './util.js'

export const name = 'lint'

const CONFIGS = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
]

export async function unavailable(dir) {
  for (const candidate of CONFIGS) {
    const found = await stat(join(dir, candidate)).then(
      () => true,
      () => false,
    )
    if (found) {
      return resolveFrom(dir, 'eslint/bin/eslint.js') ? null : 'ESLint is configured but not installed'
    }
  }
  return 'no ESLint config found'
}

export async function run(dir, opts) {
  const bin = resolveFrom(dir, 'eslint/bin/eslint.js')
  const result = await new Runner(dir, opts.timeoutMs, opts.log).run(process.execPath, [bin, '.'], {
    signal: opts.signal,
  })
  return {
    ran: true,
    ok: result.ok(),
    timedOut: result.timedOut,
    skipped: null,
    detail: result.ok() ? 'eslint .' : result.tail(30),
  }
}
