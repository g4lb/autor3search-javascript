/**
 * Executes subprocesses with a timeout, captured output and group-kill
 * semantics.
 *
 * Every child is spawned into its OWN PROCESS GROUP (detached: true) and
 * killed by group. This is not a nicety: `vitest` forks worker processes to
 * run benchmarks, so a vitest killed without taking its group with it leaves
 * those workers running — burning CPU, and corrupting every later measurement
 * on the machine, including ones belonging to other runs.
 */
import { spawn } from 'node:child_process'
import { formatDuration } from './duration.js'

/** Bytes retained per stream before output is truncated. */
export const OUTPUT_CAP = 4 * 1024 * 1024

/** Grace period between SIGTERM and SIGKILL when tearing a group down. */
const KILL_GRACE_MS = 10_000

export class Runner {
  /**
   * @param {string} dir working directory for every command
   * @param {number} timeoutMs bound on each command
   * @param {{write(s: string): void} | null} [log] receives the command line and its output
   */
  constructor(dir, timeoutMs, log = null) {
    this.dir = dir
    this.timeoutMs = timeoutMs
    this.log = log
  }

  /**
   * Runs one command to completion.
   *
   * A non-zero exit is a RESULT, not an exception — callers turn it into a
   * verdict. Only a command that could not be started at all throws.
   *
   * @param {string} command
   * @param {string[]} args
   * @param {{env?: NodeJS.ProcessEnv, cwd?: string, signal?: AbortSignal}} [opts]
   * @returns {Promise<Result>}
   */
  run(command, args, opts = {}) {
    return new Promise((resolve, reject) => {
      const started = Date.now()
      const child = spawn(command, args, {
        cwd: opts.cwd ?? this.dir,
        env: opts.env ?? process.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const stdout = new Capped(OUTPUT_CAP)
      const stderr = new Capped(OUTPUT_CAP)
      child.stdout.on('data', (chunk) => stdout.write(chunk))
      child.stderr.on('data', (chunk) => stderr.write(chunk))

      let timedOut = false
      let killTimer = null
      const timer = setTimeout(() => {
        timedOut = true
        killGroup(child.pid, 'SIGTERM')
        killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS)
        killTimer.unref()
      }, this.timeoutMs)
      timer.unref()

      const onAbort = () => {
        timedOut = true
        killGroup(child.pid, 'SIGTERM')
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })

      const cleanup = () => {
        clearTimeout(timer)
        if (killTimer) clearTimeout(killTimer)
        opts.signal?.removeEventListener('abort', onAbort)
      }

      child.on('error', (err) => {
        cleanup()
        reject(new Error(`run ${command} ${args.join(' ')}: ${err.message}`, { cause: err }))
      })

      child.on('close', (code, signal) => {
        cleanup()
        const result = new Result({
          argv: [command, ...args],
          stdout: stdout.text(),
          stderr: stderr.text(),
          // A process killed by a signal has a null exit code; report it as
          // non-zero so ok() is false rather than accidentally true.
          exitCode: code ?? (signal ? -1 : 0),
          timedOut,
          durationMs: Date.now() - started,
        })
        this.#writeLog(result)
        resolve(result)
      })
    })
  }

  #writeLog(result) {
    if (!this.log) return
    this.log.write(
      `\n$ ${result.argv.join(' ')}\n(dir=${this.dir} exit=${result.exitCode} ` +
        `timedOut=${result.timedOut} took=${formatDuration(result.durationMs)})\n`,
    )
    this.log.write(result.stdout)
    this.log.write(result.stderr)
  }
}

/** The outcome of one subprocess. */
export class Result {
  constructor(fields) {
    Object.assign(this, fields)
  }

  /** Reports a clean, in-time run. */
  ok() {
    return this.exitCode === 0 && !this.timedOut
  }

  /**
   * The last n lines of stderr, falling back to stdout when stderr is empty.
   * Used to put an actionable excerpt in a FAIL message without flooding an
   * unattended agent's context with the whole transcript.
   */
  tail(n) {
    const source = this.stderr.trim() === '' ? this.stdout : this.stderr
    const lines = source.replace(/\n+$/, '').split('\n')
    return lines.slice(Math.max(0, lines.length - Math.max(0, n))).join('\n')
  }
}

/** Retains at most `limit` bytes, then drops the rest and records that. */
class Capped {
  constructor(limit) {
    this.limit = limit
    this.chunks = []
    this.length = 0
    this.truncated = false
  }

  write(chunk) {
    const remaining = this.limit - this.length
    if (remaining <= 0) {
      this.truncated = true
      return
    }
    if (chunk.length > remaining) {
      this.chunks.push(chunk.subarray(0, remaining))
      this.length = this.limit
      this.truncated = true
      return
    }
    this.chunks.push(chunk)
    this.length += chunk.length
  }

  text() {
    const text = Buffer.concat(this.chunks).toString('utf8')
    return this.truncated ? `${text}\n[output truncated at 4MB]\n` : text
  }
}

/**
 * Signals a child's whole process group. A negative pid addresses the group.
 * Failures are swallowed: the group is already gone in the common case, and a
 * teardown that throws would mask the real result being reported.
 */
function killGroup(pid, signal) {
  if (!pid) return
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // Already exited.
    }
  }
}
