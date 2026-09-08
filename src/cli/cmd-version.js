/**
 * Prints which build of the harness is running.
 *
 * A results.tsv row is only as reproducible as the harness that produced it,
 * so this reports the package version and, when running from a checkout, the
 * commit with a `dirty` marker.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import * as gitx from '../gitx.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..', '..')

export async function runVersion(args, io) {
  parseArgs({ args, options: { C: { type: 'string', default: '.' } }, allowPositionals: false })

  const pkg = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  let provenance = 'not a git checkout'
  try {
    const commit = await gitx.headCommit(PACKAGE_ROOT)
    const clean = await gitx.isClean(PACKAGE_ROOT)
    provenance = `commit ${commit}${clean ? '' : ' (dirty)'}`
  } catch {
    // Installed from a registry rather than run from a checkout.
  }
  io.out.write(`autor3search-javascript ${pkg.version} (${provenance})\n`)
  return 0
}
