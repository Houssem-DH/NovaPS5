#!/usr/bin/env node
// Builds the Windows installer (release/NovaPS5-Setup-<version>.exe).
//
//   node scripts/dist.mjs          # NSIS installer
//   node scripts/dist.mjs --dir    # unpacked app only (release/win-unpacked)
//
// Why this wrapper exists: electron-builder unpacks its code-signing toolchain
// with symbolic links, and Windows only lets a process create symlinks when
// Developer Mode is on (or the terminal is elevated). Without that, the build
// dies with "Cannot create symbolic link : A required privilege is not held by
// the client". We detect it up front and explain what to do instead of failing
// halfway through.

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const unpackedOnly = process.argv.includes('--dir')

function canCreateSymlinks() {
  const dir = path.join(os.tmpdir(), `novaps5-symlink-probe-${process.pid}`)
  try {
    mkdirSync(dir, { recursive: true })
    const target = path.join(dir, 'target.txt')
    writeFileSync(target, 'probe')
    symlinkSync(target, path.join(dir, 'link.txt'))
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
}

if (process.platform === 'win32' && !canCreateSymlinks()) {
  console.error(`
[dist] Windows blocked symbolic-link creation, which electron-builder needs to
       unpack its signing toolchain.

       Fix it with either of these (one time):

         1. Settings ▸ System ▸ For developers ▸ Developer Mode: ON
         2. Run this build from an Administrator terminal

       Then run the build again. (The app itself installs for any user without
       admin rights — this only affects building the installer.)
`)
  process.exit(1)
}

run('node', ['scripts/fetch-python.mjs'])
run('npm', ['run', 'build'])
run('npx', ['electron-builder', '--win', ...(unpackedOnly ? ['--dir'] : [])])
