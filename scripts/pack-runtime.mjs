#!/usr/bin/env node
/**
 * Pack resources/tools into the runtime release asset the app downloads:
 *
 *   release/novaps5-runtime-win-x64.zip
 *
 * Usage:
 *   npm run pack:runtime            version from package.json "runtimeVersion"
 *   npm run pack:runtime 1.0.1      explicit version
 *
 * The zip carries a runtime.json manifest so a manual extraction yields the
 * same state as an in-app install. Publish it on a release tagged
 * runtime-v<version>.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const toolsDir = path.join(root, 'resources', 'tools')
const outDir = path.join(root, 'release')
const outZip = path.join(outDir, 'novaps5-runtime-win-x64.zip')

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = process.argv[2] || pkg.runtimeVersion || pkg.version

function fail(message) {
  console.error(`pack:runtime — ${message}`)
  process.exit(1)
}

// ---- Validate the toolset before zipping anything -------------------------
const missing = []
if (!fs.existsSync(path.join(toolsDir, 'relinker.exe'))) missing.push('relinker.exe')
// unwrap_self.py lives in scripts/ (committed — resources/tools doesn't exist
// on a fresh clone); it is copied into the bundle below.
const unwrapSource = path.join(root, 'scripts', 'unwrap_self.py')
if (!fs.existsSync(unwrapSource)) missing.push('scripts/unwrap_self.py')
const libsDir = path.join(toolsDir, 'libs')
const prx = fs.existsSync(libsDir)
  ? fs.readdirSync(libsDir).filter((f) => f.endsWith('.prx'))
  : []
if (prx.length === 0) missing.push('libs/*.prx')
const dlls = fs.existsSync(libsDir)
  ? fs.readdirSync(libsDir).filter((f) => f.endsWith('.dll'))
  : []
if (dlls.length === 0) missing.push('libs/*.dll (MinGW runtime)')

if (missing.length > 0) {
  fail(
    `tools folder is incomplete (${missing.join(', ')}) — stage a fresh build first.\n` +
      'See resources/README.md for the packing recipe.'
  )
}

// ---- Embed the manifest ---------------------------------------------------
const manifest = {
  version,
  installedAt: Date.now(),
  source: 'packed'
}
fs.writeFileSync(path.join(toolsDir, 'runtime.json'), JSON.stringify(manifest, null, 2), 'utf8')
fs.copyFileSync(unwrapSource, path.join(toolsDir, 'unwrap_self.py'))

// ---- Zip (PowerShell ships with Windows; same format Expand-Archive reads) -
fs.mkdirSync(outDir, { recursive: true })
fs.rmSync(outZip, { force: true })
const esc = (p) => p.replace(/'/g, "''")
try {
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Compress-Archive -Path '${esc(path.join(toolsDir, '*'))}' -DestinationPath '${esc(outZip)}' -Force`
    ],
    { stdio: 'inherit', windowsHide: true }
  )
} catch {
  fail('Compress-Archive failed')
}

const sizeMb = (fs.statSync(outZip).size / (1024 * 1024)).toFixed(1)
console.log(`pack:runtime — built ${path.relative(root, outZip)} (${sizeMb} MB, runtime v${version}, ${prx.length} libs)`)
console.log('')
console.log('Next:')
console.log(`  1. Create a GitHub release tagged runtime-v${version}`)
console.log(`  2. Attach ${path.basename(outZip)}`)
console.log('  3. Every NovaPS5 install updates from it on next launch')
