#!/usr/bin/env node
// Builds the Windows release:  release/NovaPS5-Setup-<version>.exe
//
//   node scripts/dist.mjs          # NSIS installer (recommended: npm run dist)
//   node scripts/dist.mjs --dir    # unpacked app only (release/win-unpacked)
//
// This wrapper exists for two reasons:
//
//  1. electron-builder unpacks its `winCodeSign` tool cache with symbolic links,
//     and Windows only grants symlink creation in Developer Mode (or from an
//     elevated shell). winCodeSign carries rcedit — the tool that stamps the
//     NovaPS5 icon, product name and version onto the exe, which is exactly what
//     we need — but the only symlinks in that archive live in its macOS payload,
//     which Windows never uses. So we unpack the archive ourselves with the
//     macOS folder excluded and drop it in electron-builder's cache: same
//     toolchain, no elevation, no Developer Mode.
//
//  2. The embeddable Python runtime is fetched first, so the packaged app is
//     self-contained and end users never install Python.

import { execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const unpackedOnly = process.argv.includes('--dir')

const cacheRoot =
  process.env.ELECTRON_BUILDER_CACHE ||
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache')

// Versions match app-builder-lib 24.x; a mismatch is harmless (we simply skip it
// and let electron-builder fetch its own copy).
const BINARIES = [
  { name: 'winCodeSign', version: '2.6.0', required: true },
  { name: 'nsis', version: '3.0.4.1', required: false },
  { name: 'nsis-resources', version: '3.4.1', required: false }
]

const sevenZip = require('7zip-bin').path7za

function run(command, args, label) {
  process.stdout.write(`\n[dist] ${label}\n`)
  execFileSync(command, args, { cwd: root, stdio: 'inherit' })
}

function download(url, destination) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'novaps5-build' } }, (response) => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume()
          download(response.headers.location, destination).then(resolve, reject)
          return
        }
        if (response.statusCode !== 200) {
          response.resume()
          reject(new Error(`HTTP ${response.statusCode} for ${url}`))
          return
        }
        const file = createWriteStream(destination)
        response.pipe(file)
        file.on('finish', () => file.close(() => resolve()))
        file.on('error', reject)
      })
      .on('error', reject)
  })
}

async function primeBinary({ name, version, required }) {
  const dir = path.join(cacheRoot, name, `${name}-${version}`)
  if (existsSync(dir)) return true

  const folder = path.join(cacheRoot, name)
  let archive = null
  if (existsSync(folder)) {
    const cached = readdirSync(folder).find((file) => file.toLowerCase().endsWith('.7z'))
    if (cached) archive = path.join(folder, cached)
  }

  if (!archive) {
    const file = `${name}-${version}.7z`
    const target = path.join(folder, file)
    mkdirSync(folder, { recursive: true })
    const url = `https://github.com/electron-userland/electron-builder-binaries/releases/download/${name}-${version}/${file}`
    try {
      await download(url, target)
      archive = target
    } catch (error) {
      if (required) process.stdout.write(`[dist] could not fetch ${file}: ${error.message}\n`)
      return false
    }
  }

  const staging = `${dir}.staging-${process.pid}`
  try {
    rmSync(staging, { recursive: true, force: true })
    // -xr!darwin: the macOS payload is the only part that needs symlinks.
    execFileSync(sevenZip, ['x', archive, `-o${staging}`, '-xr!darwin', '-y'], { stdio: 'ignore' })
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(path.dirname(dir), { recursive: true })
    renameSync(staging, dir)
    return true
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    if (required) process.stdout.write(`[dist] could not unpack ${name}: ${error.message}\n`)
    return false
  }
}

function canCreateSymlinks() {
  const dir = path.join(os.tmpdir(), `novaps5-symlink-probe-${process.pid}`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'target.txt'), 'probe')
    symlinkSync(path.join(dir, 'target.txt'), path.join(dir, 'link.txt'))
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// 1. bundled Python, so the installed app needs nothing else on the machine.
run(process.execPath, ['scripts/fetch-python.mjs'], 'bundling the Python runtime')

// 2. conversion toolchain (relinker + libraries) must be present to ship.
if (!existsSync(path.join(root, 'resources', 'tools', 'relinker.exe'))) {
  process.stdout.write(
    '[dist] warning: resources/tools/relinker.exe is missing — run `npm run setup:tools -- <AnyPS5 folder>` for a fully offline first launch.\n'
  )
}

// 3. the Windows tool cache electron-builder would otherwise try to unpack with symlinks.
const primed = {}
for (const binary of BINARIES) {
  primed[binary.name] = await primeBinary(binary)
  process.stdout.write(`[dist] toolchain ${binary.name}-${binary.version}: ${primed[binary.name] ? 'ready' : 'will be fetched by electron-builder'}\n`)
}

if (!primed.winCodeSign && !canCreateSymlinks()) {
  console.error(`
[dist] Windows blocked symbolic-link creation and the winCodeSign toolchain could
       not be prepared locally, so the build cannot stamp the app icon.

       Fix with either of these (one time):
         1. Settings ▸ System ▸ For developers ▸ Developer Mode: ON
         2. Run this build from an Administrator terminal
`)
  process.exit(1)
}

// 4. renderer/main bundles + the installer.
run(process.execPath, ['node_modules/electron-vite/bin/electron-vite.js', 'build'], 'building the app')
run(
  process.execPath,
  ['node_modules/electron-builder/out/cli/cli.js', '--win', ...(unpackedOnly ? ['--dir'] : [])],
  unpackedOnly ? 'packaging release/win-unpacked' : 'packaging the installer'
)
