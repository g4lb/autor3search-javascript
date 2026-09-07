import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { HEADER, appendRow, loadRows } from '../src/results.js'

let path
beforeEach(async () => {
  path = join(await mkdtemp(join(tmpdir(), 'a3s-results-')), 'results.tsv')
})

const row = (over = {}) => ({
  commit: 'a3f1c2d',
  score: 0.9123,
  bestBenchDelta: -12.5,
  bytesDelta: -3.25,
  status: 'keep',
  description: 'preallocate the array',
  ...over,
})

describe('appendRow', () => {
  it('creates the file with a header on the first write', async () => {
    await appendRow(path, row())
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
    expect(lines[0]).toBe(HEADER)
    expect(lines).toHaveLength(2)
  })

  it('appends without repeating the header', async () => {
    await appendRow(path, row())
    await appendRow(path, row({ commit: 'b7c2e91' }))
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines.filter((l) => l === HEADER)).toHaveLength(1)
  })

  it('flattens tabs and newlines in the description to keep one row per line', async () => {
    await appendRow(path, row({ description: 'line one\nline\ttwo\r\nthree' }))
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[1].split('\t')).toHaveLength(6)
  })

  it('truncates an over-long description so a future load cannot be jammed', async () => {
    await appendRow(path, row({ description: 'x'.repeat(400) }))
    const [loaded] = await loadRows(path)
    expect(loaded.description).toHaveLength(259)
    expect(loaded.description.endsWith('...')).toBe(true)
  })

  it('truncates by character, never splitting a multi-byte character', async () => {
    await appendRow(path, row({ description: '✅'.repeat(400) }))
    const [loaded] = await loadRows(path)
    expect(loaded.description.startsWith('✅✅')).toBe(true)
    expect(loaded.description).not.toContain('�')
  })
})

describe('loadRows', () => {
  it('returns an empty list when the file does not exist', async () => {
    expect(await loadRows(path)).toEqual([])
  })

  it('round-trips an appended row', async () => {
    await appendRow(path, row())
    expect(await loadRows(path)).toEqual([row()])
  })

  it('skips a blank trailing line', async () => {
    await appendRow(path, row())
    await writeFile(path, `${await readFile(path, 'utf8')}\n\n`)
    expect(await loadRows(path)).toHaveLength(1)
  })

  it('rejects a row with the wrong number of columns', async () => {
    await writeFile(path, `${HEADER}\nonly\ttwo\n`)
    await expect(loadRows(path)).rejects.toThrow(/6 columns/)
  })

  it('rejects a non-numeric score', async () => {
    await writeFile(path, `${HEADER}\nabc123\tnope\t0\t0\tkeep\tx\n`)
    await expect(loadRows(path)).rejects.toThrow(/score/)
  })
})
