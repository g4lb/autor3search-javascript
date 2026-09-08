import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  baseNames,
  benchFiles,
  benchFilesFor,
  benchmarks,
  frozenFiles,
  isBenchFile,
  isTestFile,
  testFiles,
} from '../src/discover.js'
import { writeFiles } from './helpers/repo.js'

let dir
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'a3s-discover-'))
})

describe('isBenchFile / isTestFile', () => {
  it('recognises bench files across extensions', () => {
    expect(isBenchFile('src/a.bench.js')).toBe(true)
    expect(isBenchFile('src/a.bench.ts')).toBe(true)
    expect(isBenchFile('src/a.js')).toBe(false)
  })

  it('recognises both test and spec naming', () => {
    expect(isTestFile('src/a.test.js')).toBe(true)
    expect(isTestFile('src/a.spec.tsx')).toBe(true)
    expect(isTestFile('__tests__/a.js')).toBe(true)
    expect(isTestFile('src/a.bench.js')).toBe(false)
  })
})

describe('benchmarks', () => {
  it('finds a top-level bench call', async () => {
    await writeFiles(dir, { 'src/a.bench.js': `import { bench } from 'vitest'\nbench('parse', () => {})\n` })
    expect(await benchmarks(dir)).toEqual([
      { name: 'parse', path: 'parse', file: 'src/a.bench.js', dir: 'src' },
    ])
  })

  it('prefixes nested describe names into the path but not the name', async () => {
    await writeFiles(dir, {
      'a.bench.js': `import { bench, describe } from 'vitest'
describe('json', () => { describe('big', () => { bench('parse', () => {}) }) })
`,
    })
    const [b] = await benchmarks(dir)
    expect(b.name).toBe('parse')
    expect(b.path).toBe('json > big > parse')
    expect(b.dir).toBe('.')
  })

  it('finds benchmarks in TypeScript and JSX without typechecking them', async () => {
    await writeFiles(dir, {
      'a.bench.ts': `import { bench } from 'vitest'\nconst x: number = 1\nbench('typed', () => x)\n`,
      'b.bench.tsx': `import { bench } from 'vitest'\nbench('jsx', () => <div />)\n`,
    })
    expect(baseNames(await benchmarks(dir))).toEqual(['jsx', 'typed'])
  })

  it('handles template-literal and bench.skip forms', async () => {
    await writeFiles(dir, {
      'a.bench.js': `import { bench } from 'vitest'
bench(\`tpl\`, () => {})
bench.skip('skipped', () => {})
`,
    })
    expect(baseNames(await benchmarks(dir))).toEqual(['skipped', 'tpl'])
  })

  it('ignores a bench call whose name is not a literal', async () => {
    await writeFiles(dir, { 'a.bench.js': `import { bench } from 'vitest'\nconst n = 'x'\nbench(n, () => {})\n` })
    expect(await benchmarks(dir)).toEqual([])
  })

  it('ignores test files and ordinary sources', async () => {
    await writeFiles(dir, {
      'a.test.js': `import { bench } from 'vitest'\nbench('nope', () => {})\n`,
      'a.js': `bench('nope2', () => {})\n`,
    })
    expect(await benchmarks(dir)).toEqual([])
  })

  it('skips an unparseable bench file rather than failing discovery', async () => {
    await writeFiles(dir, {
      'bad.bench.js': 'function ( { <<< broken\n',
      'good.bench.js': `import { bench } from 'vitest'\nbench('ok', () => {})\n`,
    })
    expect(baseNames(await benchmarks(dir))).toEqual(['ok'])
  })

  it('does not descend node_modules, dist or dot directories', async () => {
    const b = `import { bench } from 'vitest'\nbench('hidden', () => {})\n`
    await writeFiles(dir, {
      'node_modules/p/a.bench.js': b,
      'dist/a.bench.js': b,
      'coverage/a.bench.js': b,
      '.cache/a.bench.js': b,
      '_scratch/a.bench.js': b,
      'src/a.bench.js': `import { bench } from 'vitest'\nbench('real', () => {})\n`,
    })
    expect(baseNames(await benchmarks(dir))).toEqual(['real'])
  })

  it('sorts results by full path', async () => {
    await writeFiles(dir, {
      'z.bench.js': `import { bench } from 'vitest'\nbench('zeta', () => {})\n`,
      'a.bench.js': `import { bench } from 'vitest'\nbench('alpha', () => {})\n`,
    })
    expect((await benchmarks(dir)).map((b) => b.path)).toEqual(['alpha', 'zeta'])
  })

  it('finds a benchmark in a .ts file using a legacy angle-bracket cast', async () => {
    // `<number>value` is a type assertion in .ts, but Babel with the jsx
    // plugin reads it as an unclosed JSX element and the file fails to parse,
    // silently dropping its benchmarks from discovery.
    await writeFiles(dir, {
      'a.bench.ts': `import { bench } from 'vitest'
const raw: unknown = 1
const n = <number>raw
bench('cast', () => n)
`,
    })
    expect(baseNames(await benchmarks(dir))).toEqual(['cast'])
  })

  it('still parses JSX in .tsx and .jsx files', async () => {
    await writeFiles(dir, {
      'a.bench.tsx': `import { bench } from 'vitest'\nbench('tsx', () => <div />)\n`,
      'b.bench.jsx': `import { bench } from 'vitest'\nbench('jsx', () => <span />)\n`,
    })
    expect(baseNames(await benchmarks(dir))).toEqual(['jsx', 'tsx'])
  })

  it('does not follow a symlinked directory', async () => {
    const { symlink, mkdir } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await writeFiles(dir, { 'real/x.bench.js': `import { bench } from 'vitest'\nbench('real', () => {})\n` })
    await mkdir(join(dir, 'outside'), { recursive: true })
    await writeFiles(dir, { 'outside/y.bench.js': `import { bench } from 'vitest'\nbench('outside', () => {})\n` })
    await symlink(join(dir, 'outside'), join(dir, 'linked'))
    // `outside/` is walked directly, but `linked/` must not be descended, so
    // its benchmark appears exactly once rather than twice.
    const found = (await benchmarks(dir)).filter((b) => b.name === 'outside')
    expect(found).toHaveLength(1)
  })
})

describe('frozenFiles', () => {
  it('returns both bench and test files, sorted', async () => {
    await writeFiles(dir, {
      'src/a.bench.js': '\n',
      'src/a.test.js': '\n',
      'src/b.spec.ts': '\n',
      'src/a.js': '\n',
    })
    expect(await frozenFiles(dir)).toEqual(['src/a.bench.js', 'src/a.test.js', 'src/b.spec.ts'])
  })

  it('omits excluded paths', async () => {
    await writeFiles(dir, { 'a.bench.js': '\n', 'b.test.js': '\n' })
    expect(await frozenFiles(dir, ['b.test.js'])).toEqual(['a.bench.js'])
  })

  it('separates bench files from test files', async () => {
    await writeFiles(dir, { 'a.bench.js': '\n', 'b.test.js': '\n' })
    expect(await benchFiles(dir)).toEqual(['a.bench.js'])
    expect(await testFiles(dir)).toEqual(['b.test.js'])
  })

  it('classifies a .bench.test.js file once, as a test', async () => {
    await writeFiles(dir, { 'a.bench.test.js': '\n' })
    expect(await frozenFiles(dir)).toEqual(['a.bench.test.js'])
  })
})

describe('benchFilesFor', () => {
  // Vitest has no working benchmark NAME filter, so without this every round
  // measures the whole repository and discards nearly all of it. The filter
  // must narrow the work without ever narrowing what gets SCORED.
  const repo = {
    'a.bench.js': "import { bench } from 'vitest'\nbench('wanted', () => {})\n",
    'b.bench.js': "import { bench } from 'vitest'\nbench('other', () => {})\n",
    'nested/c.bench.js':
      "import { bench, describe } from 'vitest'\ndescribe('grp', () => { bench('wanted', () => {}) })\n",
  }

  it('returns only the files holding a declared benchmark', async () => {
    await writeFiles(dir, repo)
    expect(await benchFilesFor(dir, ['wanted'])).toEqual(['a.bench.js', 'nested/c.bench.js'])
  })

  it('matches the LEAF name, exactly as selectByBase does', async () => {
    // c.bench.js declares it as "grp > wanted"; the declared set records leaf
    // names, so a filter keyed on the full path would silently drop the file
    // and the benchmark would go unmeasured.
    await writeFiles(dir, repo)
    expect(await benchFilesFor(dir, ['wanted'])).toContain('nested/c.bench.js')
  })

  it('returns every bench file when nothing is declared', async () => {
    await writeFiles(dir, repo)
    expect(await benchFilesFor(dir, [])).toEqual(await benchFiles(dir))
  })

  it('returns nothing for a declared name that no longer exists', async () => {
    // [] means "no filter" downstream, so the round runs everything and
    // selectByBase fails loudly naming what it could not match — the same
    // behaviour as before this filter existed, rather than a silent empty run.
    await writeFiles(dir, repo)
    expect(await benchFilesFor(dir, ['renamed-away'])).toEqual([])
  })

  it('does not pull in a file that merely mentions the name in prose', async () => {
    await writeFiles(dir, {
      ...repo,
      'd.bench.js': "import { bench } from 'vitest'\n// wanted\nbench('unrelated', () => {})\n",
    })
    expect(await benchFilesFor(dir, ['wanted'])).not.toContain('d.bench.js')
  })
})
