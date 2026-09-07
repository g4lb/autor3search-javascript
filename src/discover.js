/**
 * Finds benchmarks and test files by PARSING them, never by running Vitest.
 *
 * Parsing means discovery works on a tree that does not build — which is
 * exactly when `init` is run, and exactly when a broken candidate needs to be
 * reported as a typecheck failure rather than as "no benchmarks found".
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, posix, relative, sep } from 'node:path'
import { parse } from '@babel/parser'

/** Extensions a bench or test file may carry. */
export const SOURCE_EXTS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx']

/** Directories never descended, matching what a JS toolchain itself ignores. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'out', '.git'])

const EXT_GROUP = SOURCE_EXTS.map((e) => e.slice(1)).join('|')
const BENCH_RE = new RegExp(`\\.bench\\.(${EXT_GROUP})$`)
const TEST_RE = new RegExp(`(\\.(test|spec)\\.(${EXT_GROUP})$)|(^|/)__tests__/`)

/** Identifiers that register a benchmark. */
const BENCH_CALLEES = new Set(['bench'])
/** Identifiers that open a naming scope around benchmarks. */
const SUITE_CALLEES = new Set(['describe', 'suite'])

/** @param {string} rel repo-relative, slash-separated */
export const isBenchFile = (rel) => BENCH_RE.test(rel)

/** @param {string} rel repo-relative, slash-separated */
export const isTestFile = (rel) => !BENCH_RE.test(rel) && TEST_RE.test(rel)

/** Every `*.bench.*` path in the repository, sorted. */
export async function benchFiles(root) {
  return (await walk(root)).filter(isBenchFile)
}

/** Every test path in the repository, sorted. */
export async function testFiles(root) {
  return (await walk(root)).filter(isTestFile)
}

/**
 * Every file that must be frozen at baseline: tests AND benchmarks.
 *
 * Freezing the benchmarks is not optional and is the main way this differs
 * from the Go harness. In Go a benchmark is a function inside a _test.go
 * file, so freezing tests froze the metric for free. Here the benchmark lives
 * in its own file — freeze only the tests and an agent can rewrite the
 * benchmark to measure something easier, with every other gate still passing.
 *
 * @param {string} root
 * @param {string[]} [exclude] repo-relative paths deliberately left unfrozen
 */
export async function frozenFiles(root, exclude = []) {
  const skip = new Set(exclude.map(toSlash))
  return (await walk(root)).filter((rel) => (isBenchFile(rel) || isTestFile(rel)) && !skip.has(rel))
}

/**
 * Every benchmark declared in the repository, sorted by full path.
 *
 * @returns {Promise<{name: string, path: string, file: string, dir: string}[]>}
 */
export async function benchmarks(root) {
  const out = []
  for (const rel of await benchFiles(root)) {
    let ast
    try {
      ast = parse(await readFile(join(root, rel), 'utf8'), {
        sourceType: 'unambiguous',
        errorRecovery: false,
        plugins: pluginsFor(rel),
      })
    } catch {
      // An unparseable bench file is not fatal to discovery. `init` reporting
      // "no benchmarks" for a whole repository because one file has a syntax
      // error would be a worse failure than silently skipping it.
      continue
    }
    const dir = posix.dirname(rel)
    collect(ast.program.body, [], (name, path) => {
      out.push({ name, path, file: rel, dir })
    })
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return out
}

/** The leaf benchmark names, sorted and deduplicated. */
export function baseNames(list) {
  return [...new Set(list.map((b) => b.name))].sort()
}

/**
 * Walks the statements of a scope, recording `bench(...)` calls and
 * descending into `describe(...)` bodies so a nested benchmark's reported
 * path matches how Vitest names the task.
 */
function collect(nodes, prefix, emit) {
  for (const node of nodes ?? []) {
    const call = asCall(node)
    if (!call) continue
    const callee = rootCalleeName(call.callee)
    const name = literalName(call.arguments?.[0])
    if (name === null) continue

    if (BENCH_CALLEES.has(callee)) {
      emit(name, [...prefix, name].join(' > '))
      continue
    }
    if (SUITE_CALLEES.has(callee)) {
      const body = call.arguments[1]
      if (body?.body?.type === 'BlockStatement') {
        collect(body.body.body, [...prefix, name], emit)
      }
    }
  }
}

/**
 * The Babel plugins to parse one file with, keyed by extension.
 *
 * `jsx` must NOT be enabled for a plain `.ts` file. There, `<number>value` is
 * a legacy type assertion, but with `jsx` on, Babel reads it as an unclosed
 * JSX element and the whole file fails to parse — so its benchmarks silently
 * vanish from discovery. TypeScript itself forbids JSX syntax in `.ts` for
 * exactly this ambiguity, which is why `.tsx` exists, so keying on the
 * extension costs nothing and cannot regress a legitimate construct.
 */
function pluginsFor(rel) {
  const common = ['decorators-legacy', 'importAttributes']
  if (/\.(mts|cts|ts)$/.test(rel)) return ['typescript', ...common]
  if (rel.endsWith('.tsx')) return ['typescript', 'jsx', ...common]
  return ['jsx', ...common]
}

/** Unwraps an expression statement into its call expression, if it is one. */
function asCall(node) {
  const expr = node?.type === 'ExpressionStatement' ? node.expression : null
  return expr?.type === 'CallExpression' ? expr : null
}

/**
 * The base identifier of a callee, so `bench.skip` and `describe.each(...)`
 * are recognised as `bench` and `describe`.
 */
function rootCalleeName(callee) {
  let node = callee
  while (node) {
    if (node.type === 'Identifier') return node.name
    if (node.type === 'MemberExpression') node = node.object
    else if (node.type === 'CallExpression') node = node.callee
    else if (node.type === 'TaggedTemplateExpression') node = node.tag
    else return null
  }
  return null
}

/**
 * The static name of a task, from a string or a template literal with no
 * substitutions. A computed name is returned as null and the call is skipped:
 * the harness must never guess at a name it will later have to match against
 * Vitest's own output.
 */
function literalName(node) {
  if (node?.type === 'StringLiteral') return node.value
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((q) => q.value.cooked).join('')
  }
  return null
}

/** Every file under root, repo-relative and slash-separated, sorted. */
async function walk(root) {
  const out = []
  async function visit(absolute) {
    let entries
    try {
      entries = await readdir(absolute, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = join(absolute, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.') || entry.name.startsWith('_')) {
          // __tests__ is the one underscore-prefixed directory that matters.
          if (entry.name !== '__tests__') continue
        }
        await visit(child)
        continue
      }
      // Deliberately does NOT follow symlinked entries: a symlink is handled
      // by src/freeze.js, which refuses them loudly rather than walking
      // through one into a tree outside the repository.
      if (!entry.isFile()) continue
      out.push(toSlash(relative(root, child)))
    }
  }
  await visit(root)
  return out.sort()
}

const toSlash = (p) => p.split(sep).join('/')
