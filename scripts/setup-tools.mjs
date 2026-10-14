#!/usr/bin/env node
// Copy the AnyPS5 toolchain into resources/tools so the app is self-contained.
//
//   npm run setup:tools -- <path-to-anypps5-folder>
//   ANYPS5_DIR=<path> npm run setup:tools
//
// The source folder should contain relinker*.exe, a libs/ directory, and (for
// SELF unwrapping) tools/unwrap_self.py — i.e. an AnyPS5 release or checkout.

import { cpSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const source = process.argv[2] || process.env.ANYPS5_DIR
if (!source || !existsSync(source)) {
  console.error('Usage: npm run setup:tools -- <path-to-anypps5-folder>')
  console.error('Expected in that folder: relinker*.exe, libs/, tools/unwrap_self.py')
  process.exit(1)
}

const dest = join(process.cwd(), 'resources', 'tools')
mkdirSync(join(dest, 'libs'), { recursive: true })

// relinker*.exe -> relinker.exe
const relinker = readdirSync(source).find((f) => /^relinker.*\.exe$/i.test(f))
if (relinker) {
  cpSync(join(source, relinker), join(dest, 'relinker.exe'))
  console.log(`relinker : ${relinker} -> relinker.exe`)
} else {
  console.warn('relinker : no relinker*.exe found in source (conversion will not work)')
}

// libs/
const libs = join(source, 'libs')
if (existsSync(libs) && statSync(libs).isDirectory()) {
  cpSync(libs, join(dest, 'libs'), { recursive: true })
  console.log('libs     : copied')
} else {
  console.warn('libs     : no libs/ folder found in source (games will not run)')
}

// unwrap_self.py (lives under tools/ in a repo, or at the root of a release)
for (const candidate of [join(source, 'tools', 'unwrap_self.py'), join(source, 'unwrap_self.py')]) {
  if (existsSync(candidate)) {
    cpSync(candidate, join(dest, 'unwrap_self.py'))
    console.log('unwrap   : unwrap_self.py copied')
    break
  }
}

console.log(`\nDone. Toolchain staged in ${dest}`)
