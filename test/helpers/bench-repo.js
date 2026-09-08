/**
 * A shared fixture: a temporary git repository with a word counter, its
 * frozen test, and its bench file, wired up so `vitest bench` runs inside it
 * without any network access.
 *
 * Vitest is made resolvable by SYMLINKING this project's own node_modules
 * into the temp repo, rather than by `npm install`-ing it there: an install
 * needs the network and is slow, and every later task that depends on this
 * fixture (18, 20, 21, 23-30) would inherit that cost on every test run.
 */
import { symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeRepo } from './repo.js'

/** This project's own node_modules, derived from this file's location so the fixture works from any checkout. */
const PROJECT_NODE_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules')

/** The deliberately slow implementation the demo optimizes away from. */
export const SLOW_WORDCOUNT = `export function countWords(s) {
  const counts = {}
  for (const field of s.split(/\\s+/)) {
    let word = ''
    for (const ch of field) {
      const lower = ch.toLowerCase()
      if (/[a-z0-9]/.test(lower)) word = word + lower
    }
    if (word !== '') counts[word] = (counts[word] ?? 0) + 1
  }
  return counts
}
`

/** A faster implementation that passes the identical frozen test. */
export const FAST_WORDCOUNT = `export function countWords(s) {
  const counts = new Map()
  for (const field of s.split(' ')) {
    let word = ''
    for (let i = 0; i < field.length; i++) {
      const c = field.charCodeAt(i)
      if (c >= 65 && c <= 90) word += String.fromCharCode(c + 32)
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) word += field[i]
    }
    if (word !== '') counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return Object.fromEntries(counts)
}
`

export const WORDCOUNT_TEST = `import { expect, test } from 'vitest'
import { countWords } from './wordcount.js'

test('counts words', () => {
  expect(countWords('the quick brown the')).toEqual({ the: 2, quick: 1, brown: 1 })
})

test('lowercases and strips punctuation', () => {
  expect(countWords('Hello, WORLD! hello?')).toEqual({ hello: 2, world: 1 })
})
`

export const WORDCOUNT_BENCH = `import { bench } from 'vitest'
import { countWords } from './wordcount.js'

const input = 'The Quick, Brown Fox! jumps over 2 lazy dogs. '.repeat(200)

bench('countWords', () => {
  if (Object.keys(countWords(input)).length === 0) throw new Error('empty result')
})
`

/**
 * A temporary git repository with Vitest resolvable, a word counter, a test
 * and a benchmark. `slow: false` seeds the fast implementation instead.
 *
 * Vitest is linked from this project's own node_modules rather than
 * installed, so the fixture costs no network and no install time.
 *
 * The `.gitignore` line is committed BEFORE node_modules is symlinked in,
 * and the symlink itself is created AFTER that commit — deliberately, so
 * node_modules is never tracked. A real project gitignores node_modules
 * (almost universally), which means a `git worktree add` checks out a tree
 * with none — the pinned baseline side of every measurement has to cope
 * with that (see linkNodeModules in src/state/index.js). Tracking the
 * symlink here would hide that entire class of bug behind a fixture that
 * doesn't exist in the wild: an earlier version of this fixture symlinked
 * node_modules with no preceding .gitignore, so a later `git add -A` in a
 * consuming test (baseline's own commit, for one) committed the symlink as
 * an ordinary tracked entry, and the worktree inherited it for free. Note
 * that the ignore line has NO trailing slash — `node_modules/` matches only
 * a directory, and would not match a symlink of that name.
 */
export async function makeBenchRepo({ slow = true } = {}) {
  const dir = await makeRepo({
    '.gitignore': 'node_modules\n',
    'package.json': JSON.stringify({ name: 'demo', private: true, type: 'module' }, null, 2) + '\n',
    'src/wordcount.js': slow ? SLOW_WORDCOUNT : FAST_WORDCOUNT,
    'src/wordcount.test.js': WORDCOUNT_TEST,
    'src/wordcount.bench.js': WORDCOUNT_BENCH,
  })
  await symlink(PROJECT_NODE_MODULES, join(dir, 'node_modules'), 'dir')
  return dir
}
