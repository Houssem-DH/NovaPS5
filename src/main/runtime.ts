import { net, app } from 'electron'
import fs from 'fs'
import path from 'path'
import type { Readable } from 'stream'
import { createHash } from 'crypto'
import { promisify } from 'util'
import { execFile } from 'child_process'
import {
  ensureDir,
  runtimeRepo,
  setToolsOverride,
  toolingPresent,
  toolsDir,
  unwrapSourcePath
} from './paths'
import type { BootstrapResult, BootstrapStep, RuntimeManifest } from '@shared/types'

const execFileAsync = promisify(execFile)

/**
 * Single-file bundle produced by `npm run pack:runtime` — supported as a
 * fallback so a fork can host its own runtime releases alongside the upstream
 * AnyPS5 split assets (prx-windows-*.zip + relinker-*.exe).
 */
export const RUNTIME_ASSET = 'novaps5-runtime-win-x64.zip'
const MANIFEST_NAME = 'runtime.json'

type StepSink = (step: BootstrapStep) => void

interface AssetFile {
  name: string
  url: string
  /** Lowercase hex, null when the release page didn't publish one. */
  sha256: string | null
}

interface RuntimeRelease {
  /** Normalized version for comparison/display, e.g. "0.1.2" from tag "v0.1.2". */
  version: string
  tag: string
  prx?: AssetFile
  relinker?: AssetFile
  bundle?: AssetFile
}

// Serialize concurrent bootstrap runs (first-run screen + Settings "check now").
let running: Promise<BootstrapResult> | null = null

export function readRuntimeManifest(dir = toolsDir()): RuntimeManifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_NAME), 'utf8')) as RuntimeManifest
    if (parsed && typeof parsed.version === 'string') return parsed
  } catch {
    // no manifest yet (e.g. tools copied in by hand)
  }
  return null
}

function writeManifest(dir: string, manifest: RuntimeManifest): void {
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2), 'utf8')
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function normalizeVersion(tag: string): string {
  const flat = tag.replace(/^runtime[-v]*/i, '').replace(/^v/i, '')
  return flat || tag
}

// ---- GitHub release discovery (HTML — no API rate limits) ------------------

function requestBuffer(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  redirect = 0
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = net.request(url)
    for (const [key, value] of Object.entries(headers)) request.setHeader(key, value)
    const timer = setTimeout(() => {
      request.abort()
      reject(new Error('timed out'))
    }, timeoutMs)
    const chunks: Buffer[] = []
    request.on('response', (response) => {
      const rawLocation = response.headers['location']
      const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        clearTimeout(timer)
        const status = response.statusCode ?? 0
        if (status >= 300 && status < 400 && location) {
          if (redirect >= 5) return reject(new Error('too many redirects'))
          resolve(requestBuffer(new URL(location, url).toString(), headers, timeoutMs, redirect + 1))
          return
        }
        resolve({ status, body: Buffer.concat(chunks) })
      })
      response.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
    request.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    request.end()
  })
}

async function fetchHtml(url: string): Promise<string> {
  const response = await requestBuffer(
    url,
    {
      'User-Agent': 'NovaPS5',
      Accept: 'text/html,application/xhtml+xml',
      // deterministic body — some middleboxes gzip regardless of support
      'Accept-Encoding': 'identity'
    },
    20_000
  )
  if (response.status === 404) return ''
  if (response.status !== 200) throw new Error(`GitHub returned HTTP ${response.status}`)
  return response.body.toString('utf8')
}

/**
 * Split assets of one release page entry:
 *   .../releases/download/<tag>/<asset>   followed by its "sha256:..." line.
 */
function parseAssets(repo: string, html: string): AssetFile[] {
  const out: AssetFile[] = []
  const parts = html.split('/releases/download/')
  for (let i = 1; i < parts.length; i++) {
    const match = parts[i].match(/^([^/"]+)\/([^"?]+)"/)
    if (!match) continue
    const sha = parts[i].match(/sha256:([0-9a-f]{64})/i)
    out.push({
      name: decodeURIComponent(match[2]),
      url: `https://github.com/${repo}/releases/download/${match[1]}/${match[2]}`,
      sha256: sha ? sha[1].toLowerCase() : null
    })
  }
  return out
}

async function findLatestRuntime(repo: string): Promise<RuntimeRelease | null> {
  const listHtml = await fetchHtml(`https://github.com/${repo}/releases`)
  if (!listHtml) return null // no releases published
  const tagMatch = listHtml.match(/\/releases\/tag\/([^"'?#<\s]+)/)
  if (!tagMatch) return null // releases page exists but is empty
  const tag = decodeURIComponent(tagMatch[1])

  const assets = parseAssets(repo, await fetchHtml(`https://github.com/${repo}/releases/expanded_assets/${encodeURIComponent(tag)}`))
  return {
    version: normalizeVersion(tag),
    tag,
    prx: assets.find((a) => /^prx-windows-.+\.zip$/i.test(a.name)),
    relinker: assets.find((a) => /^relinker-.+\.exe$/i.test(a.name)),
    bundle: assets.find((a) => a.name === RUNTIME_ASSET)
  }
}

// ---- Download --------------------------------------------------------------

function downloadFile(url: string, dest: string, onPercent: (pct: number) => void, redirect = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = net.request(url)
    request.setHeader('User-Agent', 'NovaPS5')
    let settled = false
    const finish = (err?: Error): void => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve()
    }
    const timer = setTimeout(() => {
      request.abort()
      finish(new Error('download timed out'))
    }, 15 * 60_000)

    request.on('response', (response) => {
      const status = response.statusCode ?? 0
      const rawLocation = response.headers['location']
      const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation
      if (status >= 300 && status < 400 && location) {
        ;(response as unknown as Readable).resume()
        clearTimeout(timer)
        if (redirect >= 5) return finish(new Error('too many redirects'))
        downloadFile(new URL(location, url).toString(), dest, onPercent, redirect + 1).then(
          () => finish(),
          (err: Error) => finish(err)
        )
        return
      }
      if (status !== 200) {
        ;(response as unknown as Readable).resume()
        clearTimeout(timer)
        return finish(new Error(`download failed (HTTP ${status})`))
      }

      const rawLength = response.headers['content-length']
      const total = Number(Array.isArray(rawLength) ? rawLength[0] : rawLength ?? 0)
      let received = 0
      let lastPct = -1
      const out = fs.createWriteStream(dest)
      out.on('error', (err) => {
        clearTimeout(timer)
        finish(err)
      })
      response.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (total > 0) {
          const pct = Math.min(99, Math.floor((received * 100) / total))
          if (pct !== lastPct) {
            lastPct = pct
            onPercent(pct)
          }
        }
      })
      response.on('end', () => {
        out.end(() => {
          clearTimeout(timer)
          onPercent(100)
          finish()
        })
      })
      response.on('error', (err) => {
        clearTimeout(timer)
        finish(err)
      })
      ;(response as unknown as Readable).pipe(out)
    })
    request.on('error', (err) => {
      clearTimeout(timer)
      finish(err instanceof Error ? err : new Error(String(err)))
    })
    request.end()
  })
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

async function downloadAsset(
  asset: AssetFile,
  dest: string,
  label: string,
  emit: StepSink,
  detail: string
): Promise<void> {
  await downloadFile(asset.url, dest, (percent) => {
    emit({ id: 'download', label, status: 'active', percent, detail })
  })
  if (asset.sha256) {
    const actual = await sha256File(dest)
    if (actual !== asset.sha256) throw new Error(`checksum mismatch for ${asset.name}`)
  }
}

// ---- Install --------------------------------------------------------------

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  ensureDir(destDir)
  const esc = (p: string): string => p.replace(/'/g, "''")
  await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath '${esc(zipPath)}' -DestinationPath '${esc(destDir)}' -Force`
    ],
    { windowsHide: true }
  )
}

function looksLikeRuntime(dir: string): boolean {
  try {
    const libs = path.join(dir, 'libs')
    const hasLibs = fs.existsSync(libs) && fs.readdirSync(libs).some((f) => f.endsWith('.prx'))
    return fs.existsSync(path.join(dir, 'relinker.exe')) && hasLibs
  } catch {
    return false
  }
}

/**
 * The unwrap helper ships with the app (scripts/unwrap_self.py) — copy it
 * into the runtime folder, refreshing whenever the committed copy differs:
 * the app's copy is canonical (split upstream releases don't ship the script
 * at all, and app fixes must reach an already-installed runtime).
 */
function ensureUnwrapScript(targetDir: string): void {
  try {
    const dest = path.join(targetDir, 'unwrap_self.py')
    const source = unwrapSourcePath()
    if (!fs.existsSync(source)) return
    const incoming = fs.readFileSync(source)
    let current: Buffer | null = null
    try {
      current = fs.readFileSync(dest)
    } catch {
      current = null
    }
    if (current && current.equals(incoming)) return
    fs.writeFileSync(dest, incoming)
  } catch {
    // non-fatal — the install pipeline reports a missing unwrap script later
  }
}

/** Resolve the folder installs write into; falls back to userData when unwritable. */
function installTarget(): string {
  const current = toolsDir()
  try {
    ensureDir(current)
    const probe = path.join(current, `.write-probe-${process.pid}`)
    fs.writeFileSync(probe, '')
    fs.rmSync(probe, { force: true })
    return current
  } catch {
    const fallback = path.join(app.getPath('userData'), 'tools')
    setToolsOverride(fallback)
    ensureDir(fallback)
    return fallback
  }
}

/** Swap the staged folder in (same volume → atomic renames), keeping a backup until done. */
function swapIn(stageDir: string, target: string): void {
  const backup = `${target}.old`
  fs.rmSync(backup, { recursive: true, force: true })
  if (fs.existsSync(target)) {
    fs.renameSync(target, backup)
    try {
      fs.renameSync(stageDir, target)
    } catch (err) {
      fs.renameSync(backup, target) // roll back
      throw err
    }
    fs.rmSync(backup, { recursive: true, force: true })
  } else {
    fs.renameSync(stageDir, target)
  }
}

// ---- Bootstrap ------------------------------------------------------------

async function ensureRuntimeOnce(emit: StepSink): Promise<BootstrapResult> {
  const step = (s: BootstrapStep): void => emit(s)
  const fail = (id: BootstrapStep['id'], label: string, error: unknown): BootstrapResult => {
    const message = error instanceof Error ? error.message : String(error)
    step({ id, label, status: 'error', detail: message })
    return { ok: false, runtimeVersion: readRuntimeManifest()?.version ?? null, updated: false, error: message }
  }
  const ready = (runtimeVersion: string | null, updated: boolean): BootstrapResult => {
    step({ id: 'ready', label: 'Ready', status: 'done', detail: updated ? 'Runtime installed' : undefined })
    return { ok: true, runtimeVersion, updated }
  }

  const target = installTarget()
  ensureUnwrapScript(target)

  const checkLabel = 'Checking for runtime updates'
  step({ id: 'check', label: checkLabel, status: 'active' })

  const present = toolingPresent()
  const toolsReady = present.relinker && present.libs
  const manifest = readRuntimeManifest(target)

  // ---- Reach the releases page ----
  let release: RuntimeRelease | null = null
  try {
    release = await findLatestRuntime(runtimeRepo())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (toolsReady) {
      step({ id: 'check', label: checkLabel, status: 'warn', detail: `Offline (${message}) — using installed runtime` })
      return ready(manifest?.version ?? null, false)
    }
    return fail('check', checkLabel, `Runtime not installed and update check failed: ${message}`)
  }

  // ---- No releases published yet ----
  if (!release) {
    if (toolsReady) {
      step({ id: 'check', label: checkLabel, status: 'done', detail: `Runtime v${manifest?.version ?? 'bundled'} — no releases published yet` })
      if (!manifest) {
        writeManifest(target, { version: 'bundled', installedAt: Date.now(), source: `github:${runtimeRepo()}` })
      }
      return ready(manifest?.version ?? 'bundled', false)
    }
    return fail('check', checkLabel, 'Runtime not installed and no release has been published yet.')
  }

  // ---- Up to date? ----
  if (toolsReady && manifest?.version === release.version) {
    step({ id: 'check', label: checkLabel, status: 'done', detail: `Runtime v${release.version} is up to date` })
    return ready(release.version, false)
  }

  // ---- Install / update ----
  step({
    id: 'check',
    label: checkLabel,
    status: 'done',
    detail: !toolsReady
      ? `Runtime ${release.version} will be installed`
      : `Update available: ${manifest?.version ?? 'unknown'} → ${release.version}`
  })

  const stamp = Date.now()
  const tempDir = app.getPath('temp')
  const downloadLabel = `Downloading runtime v${release.version}`

  interface PlannedFile {
    kind: 'bundle' | 'prx' | 'relinker'
    asset: AssetFile
    dest: string
  }
  const planned: PlannedFile[] = []
  if (release.bundle) {
    planned.push({ kind: 'bundle', asset: release.bundle, dest: path.join(tempDir, `nova-runtime-${stamp}.zip`) })
  } else {
    if (release.prx) planned.push({ kind: 'prx', asset: release.prx, dest: path.join(tempDir, `nova-prx-${stamp}.zip`) })
    if (release.relinker) {
      planned.push({ kind: 'relinker', asset: release.relinker, dest: path.join(tempDir, `nova-relinker-${stamp}.exe`) })
    }
  }

  if (planned.length === 0) {
    return fail('download', downloadLabel, `release ${release.tag} has no Windows runtime assets`)
  }

  try {
    step({ id: 'download', label: downloadLabel, status: 'active', percent: 0 })
    let totalBytes = 0
    for (let i = 0; i < planned.length; i++) {
      const file = planned[i]
      const detail = planned.length > 1 ? `${i + 1}/${planned.length} ${file.asset.name}` : file.asset.name
      await downloadAsset(file.asset, file.dest, downloadLabel, emit, detail)
      totalBytes += fs.statSync(file.dest).size
    }
    step({ id: 'download', label: downloadLabel, status: 'done', detail: `${mb(totalBytes)} — ${planned.length} file${planned.length === 1 ? '' : 's'}` })
  } catch (error) {
    for (const file of planned) fs.rmSync(file.dest, { force: true })
    return fail('download', downloadLabel, error)
  }

  const staging = path.join(path.dirname(target), `.runtime-staging-${stamp}`)
  try {
    step({ id: 'extract', label: 'Extracting files', status: 'active' })
    fs.rmSync(staging, { recursive: true, force: true })
    ensureDir(staging)

    const bundle = planned.find((f) => f.kind === 'bundle')
    const prx = planned.find((f) => f.kind === 'prx')
    const relinker = planned.find((f) => f.kind === 'relinker')
    if (bundle) {
      // Self-hosted bundle carries the whole tools layout at the zip root.
      await extractZip(bundle.dest, staging)
    } else {
      if (!prx) throw new Error('release is missing prx-windows-*.zip')
      if (!relinker) throw new Error('release is missing relinker-*.exe')
      // Upstream zip root is libs/ (prx + MinGW dlls) — exactly our layout.
      await extractZip(prx.dest, staging)
      fs.copyFileSync(relinker.dest, path.join(staging, 'relinker.exe'))
    }
    if (!looksLikeRuntime(staging)) {
      throw new Error('extracted files are missing relinker.exe or libs/*.prx')
    }
    step({ id: 'extract', label: 'Extracting files', status: 'done' })
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    for (const file of planned) fs.rmSync(file.dest, { force: true })
    return fail('extract', 'Extracting files', error)
  }

  try {
    step({ id: 'install', label: 'Installing runtime', status: 'active' })
    swapIn(staging, target)
    ensureUnwrapScript(target)
    writeManifest(target, {
      version: release.version,
      installedAt: Date.now(),
      source: `github:${runtimeRepo()}`
    })
    for (const file of planned) fs.rmSync(file.dest, { force: true })
    step({ id: 'install', label: 'Installing runtime', status: 'done', detail: `v${release.version}` })
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    for (const file of planned) fs.rmSync(file.dest, { force: true })
    return fail('install', 'Installing runtime', error)
  }

  return ready(release.version, true)
}

/**
 * Check the configured repo's releases and install the runtime when it is
 * missing or older. Runs on every launch (fast when already up to date) and
 * drives the bootstrap checklist through `emit`.
 */
export function ensureRuntime(emit: StepSink): Promise<BootstrapResult> {
  if (!running) {
    running = ensureRuntimeOnce(emit).finally(() => {
      running = null
    })
  }
  return running
}
