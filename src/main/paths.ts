import { app } from 'electron'
import path from 'path'
import fs from 'fs'

/** GitHub repo (owner/name) queried for runtime releases. Overridable via config.json. */
export const DEFAULT_RUNTIME_REPO = 'boykopovar/AnyPS5'

/** This app's own repository — the source of its releases and update feed. */
export const APP_REPO = 'Houssem-DH/NovaPS5'

export interface AppConfig {
  /** Absolute games folder; undefined/null = default (<libraryRoot>/games). */
  gamesDir?: string | null
  /** Overrides DEFAULT_RUNTIME_REPO when set. */
  runtimeRepo?: string | null
}

// Set by the bootstrap when the bundled tools location isn't writable
// (e.g. a per-machine install under Program Files) — updates then live in
// userData instead.
let toolsOverride: string | null = null

export function setToolsOverride(dir: string | null): void {
  toolsOverride = dir
}

/**
 * Where the conversion tooling (relinker + libs + unwrap) lives.
 *  - dev:      <project>/resources/tools
 *  - packaged: <resources>/tools, or <userData>/tools when that location is
 *              missing/not writable (so first-run installs & updates always work).
 */
export function toolsDir(): string {
  if (toolsOverride) return toolsOverride
  if (app.isPackaged) {
    const installed = path.join(process.resourcesPath, 'tools')
    if (fs.existsSync(installed) && isWritableDir(installed)) return installed
    return path.join(app.getPath('userData'), 'tools')
  }
  // In dev, main runs from <project>/out/main, so project root is two levels up.
  return path.join(app.getAppPath(), 'resources', 'tools')
}

/**
 * Python runtime shipped with the app so end users never install Python.
 *  - dev:      <project>/resources/python
 *  - packaged: <resources>/python (electron-builder extraResources)
 * Populated by `npm run setup:python` / the dist scripts.
 */
export function bundledPythonDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'python')
    : path.join(app.getAppPath(), 'resources', 'python')
}

export function bundledPythonExe(): string {
  return path.join(bundledPythonDir(), process.platform === 'win32' ? 'python.exe' : 'python3')
}

export function relinkerPath(): string {
  return path.join(toolsDir(), 'relinker.exe')
}

export function unwrapScriptPath(): string {
  return path.join(toolsDir(), 'unwrap_self.py')
}

/**
 * Committed copy of the SELF-unwrap helper (scripts/unwrap_self.py). A fresh
 * clone has no resources/tools at all, so the canonical source lives in the
 * repo and is copied into the tools folder by the bootstrap. Readable from
 * inside asar via Electron's patched fs — never handed to Python directly.
 */
export function unwrapSourcePath(): string {
  return path.join(app.getAppPath(), 'scripts', 'unwrap_self.py')
}

export function runtimeLibsDir(): string {
  return path.join(toolsDir(), 'libs')
}

/**
 * Root of the user's library (index + config). Games live in gamesRoot().
 * Kept out of the project folder so large installs don't sit inside OneDrive
 * or the repo. An existing pre-rename library keeps its old folder so current
 * games stay registered; fresh installs get the NovaPS5 folder.
 */
export function libraryRoot(): string {
  const docs = app.getPath('documents')
  const legacy = path.join(docs, 'PS5 Library')
  try {
    if (fs.existsSync(legacy)) return legacy
  } catch {
    // fall through to the default below
  }
  return path.join(docs, 'NovaPS5 Library')
}

export function configFile(): string {
  return path.join(libraryRoot(), 'config.json')
}

let configCache: AppConfig | null = null

export function loadConfig(): AppConfig {
  if (configCache) return configCache
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile(), 'utf8')) as AppConfig
    configCache = parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    configCache = {}
  }
  return configCache
}

export function saveConfig(cfg: AppConfig): void {
  configCache = cfg
  ensureDir(libraryRoot())
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2), 'utf8')
}

/** Where games are installed. Defaults to <libraryRoot>/games. */
export function gamesRoot(): string {
  const custom = loadConfig().gamesDir
  if (custom) return custom
  return path.join(libraryRoot(), 'games')
}

export function runtimeRepo(): string {
  return loadConfig().runtimeRepo || DEFAULT_RUNTIME_REPO
}

export function libraryFile(): string {
  return path.join(libraryRoot(), 'library.json')
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

function isWritableDir(dir: string): boolean {
  try {
    const probe = path.join(dir, `.write-probe-${process.pid}`)
    fs.writeFileSync(probe, '')
    fs.rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
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
