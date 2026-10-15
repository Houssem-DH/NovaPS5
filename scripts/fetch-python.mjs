// Downloads the embeddable Python runtime that ships inside the installer, so
// end users never have to install Python themselves. Runs automatically before
// `npm run dist`; safe to re-run (it skips when already present).
//
//   node scripts/fetch-python.mjs [--force]

import { execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs'
import { readdir, rename } from 'node:fs/promises'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PYTHON_VERSION = process.env.NOVAPS5_PYTHON_VERSION || '3.12.7'
const ARCHIVE = `python-${PYTHON_VERSION}-embed-amd64.zip`
const URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/${ARCHIVE}`

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = path.join(root, 'resources', 'python')
const force = process.argv.includes('--force')

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest)
    https
      .get(url, (response) => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          file.close()
          rmSync(dest, { force: true })
          download(response.headers.location, dest).then(resolve, reject)
          return
        }
        if (response.statusCode !== 200) {
          file.close()
          rmSync(dest, { force: true })
          reject(new Error(`Download failed: HTTP ${response.statusCode} for ${url}`))
          return
        }
        response.pipe(file)
        file.on('finish', () => file.close(() => resolve()))
      })
      .on('error', (error) => {
        file.close()
        rmSync(dest, { force: true })
        reject(error)
      })
  })
}

async function main() {
  const exe = path.join(target, 'python.exe')
  if (existsSync(exe) && !force) {
    console.log(`[python] embeddable Python ${PYTHON_VERSION} already present at resources/python`)
    return
  }

  mkdirSync(target, { recursive: true })
  const zip = path.join(root, 'resources', ARCHIVE)
  console.log(`[python] downloading ${URL}`)
  await download(URL, zip)

  // Windows' bsdtar (tar.exe) unpacks zip archives; keep the extraction flat so
  // python.exe ends up directly inside resources/python.
  execFileSync('tar', ['-xf', zip, '-C', target], { stdio: 'inherit' })
  rmSync(zip, { force: true })

  // Some archives nest a folder — flatten it if so.
  const entries = await readdir(target)
  if (!entries.includes('python.exe')) {
    for (const entry of entries) {
      const nested = path.join(target, entry, 'python.exe')
      if (existsSync(nested)) {
        for (const inner of await readdir(path.join(target, entry))) {
          await rename(path.join(target, entry, inner), path.join(target, inner))
        }
        break
      }
    }
  }

  if (!existsSync(exe)) throw new Error('[python] python.exe missing after extraction')
  console.log(`[python] ready → ${target}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
