/** Profiles the declared benchmarks and prints where the time actually goes. */
import { parseArgs } from 'node:util'
import { profile } from '../profile.js'
import { loadRepoConfig, resolveRepo } from './context.js'

export async function runProfile(args, io) {
  const { values } = parseArgs({
    args,
    options: { C: { type: 'string', default: '.' }, top: { type: 'string', default: '15' } },
    allowPositionals: false,
  })

  const root = await resolveRepo(values.C)
  const cfg = await loadRepoConfig(root)
  const reports = await profile(root, cfg, { top: Number(values.top) })

  for (const report of reports) {
    io.out.write(`\n${report.file}\n`)
    if (report.top.length === 0) {
      io.out.write('  (no samples attributable to benchmarked code)\n')
      continue
    }
    io.out.write(`${'self ms'.padStart(9)}  ${'%'.padStart(6)}  function\n`)
    for (const entry of report.top) {
      io.out.write(
        `${entry.selfMs.toFixed(1).padStart(9)}  ${entry.pct.toFixed(1).padStart(6)}  ` +
          `${entry.name}${entry.file ? `  (${entry.file})` : ''}\n`,
      )
    }
    io.out.write(`\n  cpu   ${report.cpuProfile}\n`)
    io.out.write(`  heap  ${report.heapProfile}\n`)
  }
  io.out.write(
    '\nopen a .cpuprofile or .heapprofile in Chrome DevTools (Performance > Load profile) or at\n' +
      'https://speedscope.app for a flame graph.\n',
  )
  return 0
}
