import { app } from 'electron'
import path from 'path'
import fs from 'fs'

/**
 * Where the bundled AnyPS5 tooling lives.
 *  - dev:      <project>/resources/tools
 *  - packaged: <resources>/tools   (via electron-builder extraResources)
 */
export function toolsDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'tools')
  }
  // In dev, main runs from <project>/out/main, so project root is two levels up.
  return path.join(app.getAppPath(), 'resources', 'tools')
}

export function relinkerPath(): string {
  return path.join(toolsDir(), 'relinker.exe')
}

export function unwrapScriptPath(): string {
  return path.join(toolsDir(), 'unwrap_self.py')
}

export function runtimeLibsDir(): string {
  return path.join(toolsDir(), 'libs')
}

/**
 * Root of the user's library. Games live in <libraryRoot>/games/<id>, and the
 * index is <libraryRoot>/library.json. Kept out of the project folder so large
 * installs don't sit inside OneDrive or the repo.
 */
export function libraryRoot(): string {
  return path.join(app.getPath('documents'), 'PS5 Library')
}

export function gamesRoot(): string {
  return path.join(libraryRoot(), 'games')
}

export function libraryFile(): string {
  return path.join(libraryRoot(), 'library.json')
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

export function toolingPresent(): { relinker: boolean; libs: boolean; unwrap: boolean } {
  const libs = runtimeLibsDir()
  let libsPresent = false
  try {
    libsPresent = fs.existsSync(libs) && fs.readdirSync(libs).some((f) => f.endsWith('.prx'))
  } catch {
    libsPresent = false
  }
  return {
    relinker: fs.existsSync(relinkerPath()),
    libs: libsPresent,
    unwrap: fs.existsSync(unwrapScriptPath())
  }
}
