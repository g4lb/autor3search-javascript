/**
 * Subcommand registry and dispatch.
 *
 * The binary never edits source code. It gates correctness, measures
 * candidate against baseline, and returns a verdict.
 */
import { runVersion } from './cmd-version.js'

/** Exit codes. program.md branches on 0-3; 64 is the conventional usage code. */
export const EXIT_USAGE = 64

const COMMANDS = [
  ['init', 'scan the repo, discover benchmarks, write config and program.md', () => import('./cmd-init.js').then((m) => m.runInit)],
  ['doctor', 'check whether this machine can measure reliably', () => import('./cmd-doctor.js').then((m) => m.runDoctor)],
  ['baseline', 'create the run branch, freeze tests and benchmarks, record the baseline', () => import('./cmd-baseline.js').then((m) => m.runBaseline)],
  ['profile', 'profile the declared benchmarks and report hot spots', () => import('./cmd-profile.js').then((m) => m.runProfile)],
  ['eval', 'run one experiment step and return a verdict', () => import('./cmd-eval.js').then((m) => m.runEval)],
  ['status', 'show where the run is: branch, worktree, experiments, stop state', () => import('./cmd-status.js').then((m) => m.runStatus)],
  ['stop', 'ask the agent to end the run after the current experiment', () => import('./cmd-stop.js').then((m) => m.runStop)],
  ['report', 'summarize results.tsv', () => import('./cmd-report.js').then((m) => m.runReport)],
  ['version', 'print which build of the harness this is', async () => runVersion],
]

function usage(io) {
  io.err.write('autor3search-javascript — autonomous JavaScript performance optimization harness\n')
  io.err.write('\nusage: autor3search-javascript <command> [flags]\n\ncommands:\n')
  for (const [name, summary] of COMMANDS) io.err.write(`  ${name.padEnd(9)} ${summary}\n`)
  io.err.write('\nevery command accepts -C <dir> to run against another repository\n')
}

/**
 * @param {string[]} argv arguments after the program name
 * @param {{out: {write(s: string): void}, err: {write(s: string): void}}} io
 * @returns {Promise<number>} the process exit code
 */
export async function dispatch(argv, io) {
  if (argv.length === 0) {
    usage(io)
    return EXIT_USAGE
  }
  const entry = COMMANDS.find(([name]) => name === argv[0])
  if (!entry) {
    io.err.write(`unknown command "${argv[0]}"\n\n`)
    usage(io)
    return EXIT_USAGE
  }

  try {
    const run = await entry[2]()
    return await run(argv.slice(1), io)
  } catch (err) {
    // A bad flag is a usage error, not a crash: report it in one line rather
    // than as a stack trace an unattended agent would have to parse.
    if (err.code?.startsWith('ERR_PARSE_ARGS')) {
      io.err.write(`${err.message}\n\n`)
      usage(io)
      return EXIT_USAGE
    }
    io.err.write(`${err.message}\n`)
    return 2
  }
}
