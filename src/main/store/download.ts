// Download + install pipeline for the store.
//
// The only URLs NovaPS5 will fetch are ones the user supplied (a self-hosted
// catalog entry or a URL they attached themselves). A local path works too:
// the file is passed straight to the existing conversion pipeline.

import fs from 'fs'
import { promises as fsp } from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { ensureDir, downloadsRoot } from '../paths'
import { installGame } from '../pipeline/install'
import { updateStoreEntry } from './library'
import type { StoreDownloadProgress, StoreGame } from '@shared/types'

type Emit = (progress: StoreDownloadProgress) => void

const active = new Map<string, AbortController>()

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

function isHttp(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'game'
  )
}

function fileNameFromUrl(url: string, name: string): string {
  try {
    const parsed = new URL(url)
    // Decode and basename the last path segment so a crafted URL can never
    // escape the downloads folder, then rebuild a clean name with the original
    // archive extension.
    const base = path.basename(decodeURIComponent(parsed.pathname.split('/').pop() ?? ''))
    const match = base.match(/\.(zip|rar|7z)$/i)
    if (match) {
      const ext = match[1].toLowerCase()
      return `${slug(base.slice(0, -match[0].length))}.${ext}`
    }
    return `${slug(base.replace(/\.[^.]+$/, '') || name)}.zip`
  } catch {
    return `${slug(name)}.zip`
  }
}

function makeReport(jobId: string, game: StoreGame, emit: Emit) {
  return (
    step: StoreDownloadProgress['step'],
    message: string,
    percent: number,
    extra: Partial<Pick<StoreDownloadProgress, 'receivedBytes' | 'totalBytes'>> = {}
  ): void => {
    emit({
      jobId,
      gameId: game.id,
      gameName: game.name,
      step,
      message,
      percent: Math.max(0, Math.min(100, Math.round(percent))),
      status: 'running',
      ...extra
    })
  }
}

async function installFromPath(
  game: StoreGame,
  sourcePath: string,
  jobId: string,
  emit: Emit,
  basePercent: number
): Promise<void> {
  const span = 100 - basePercent
  const installed = await installGame(
    sourcePath,
    game.name,
    (progress) => {
      // The pipeline's own error report is rethrown; the caller emits it once.
      if (progress.status !== 'running') return
      emit({
        jobId,
        gameId: game.id,
        gameName: game.name,
        step: 'installing',
        message: progress.message,
        percent: Math.max(0, Math.min(100, Math.round(basePercent + (progress.percent / 100) * span))),
        status: 'running'
      })
    },
    jobId
  )

  // The install succeeded; a write failure should not report it as a failure.
  await updateStoreEntry(game.id, { status: 'installed', installedGameId: installed.id }).catch(
    () => {}
  )
  emit({
    jobId,
    gameId: game.id,
    gameName: game.name,
    step: 'done',
    message: `${game.name} installed`,
    percent: 100,
    status: 'done',
    installedGameId: installed.id
  })
}

/** Download a user-hosted archive (or install a local path) and convert it. */
export async function startStoreDownload(
  game: StoreGame,
  url: string,
  jobId: string,
  emit: Emit
): Promise<void> {
  const report = makeReport(jobId, game, emit)
  const target = url.trim()
  let destDir: string | null = null
  let connectTimedOut = false

  try {
    await updateStoreEntry(game.id, { status: 'downloading' })

    // A catalog may point at a local folder/archive — no download needed.
    if (!isHttp(target)) {
      report('queued', `Opening ${game.name}…`, 1)
      const local = target.startsWith('file://') ? fileURLToPath(target) : target
      if (!fs.existsSync(local)) throw new Error(`The catalog points at "${target}", which does not exist.`)
      await installFromPath(game, local, jobId, emit, 0)
      return
    }

    destDir = path.join(downloadsRoot(), `${slug(game.name)}-${Date.now()}`)
    ensureDir(destDir)
    const dest = path.join(destDir, fileNameFromUrl(target, game.name))

    const controller = new AbortController()
    active.set(jobId, controller)
    report('queued', `Connecting to the download server…`, 0)

    const connectTimer = setTimeout(() => {
      connectTimedOut = true
      controller.abort()
    }, 45_000)
    let response: Response
    try {
      response = await fetch(target, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*' }
      })
    } finally {
      clearTimeout(connectTimer)
    }
    if (!response.ok || !response.body) {
      throw new Error(`Download failed — the server returned ${response.status}.`)
    }

    const total = Number(response.headers.get('content-length')) || game.sizeBytes || 0
    const handle = await fsp.open(dest, 'w')
    const hash = game.sha256 ? crypto.createHash('sha256') : null
    const reader = response.body.getReader()
    let received = 0
    let lastEmit = 0

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        await handle.write(value)
        received += value.length
        hash?.update(value)

        const now = Date.now()
        if (now - lastEmit > 250) {
          lastEmit = now
          const percent =
            total > 0
              ? Math.min(88, (received / total) * 88)
              : Math.min(88, 5 + received / (1024 * 1024))
          report('downloading', `Downloading ${game.name}…`, percent, {
            receivedBytes: received,
            totalBytes: total || undefined
          })
        }
      }
    } finally {
      await handle.close()
      active.delete(jobId)
    }

    report('downloading', `Downloaded ${game.name}`, 90, {
      receivedBytes: received,
      totalBytes: total || undefined
    })

    if (hash && game.sha256) {
      report('verifying', 'Verifying the download…', 91)
      const digest = hash.digest('hex').toLowerCase()
      if (digest !== game.sha256.trim().toLowerCase()) {
        throw new Error('The download did not match its SHA-256 checksum — it may be corrupted.')
      }
    }

    if (!/\.(zip|rar|7z)$/i.test(dest)) {
      throw new Error('The downloaded file is not an archive (.zip/.rar/.7z). Point the catalog at a game archive.')
    }

    await installFromPath(game, dest, jobId, emit, 91)
    await fsp.rm(destDir, { recursive: true, force: true }).catch(() => {})
    destDir = null
  } catch (error) {
    active.delete(jobId)
    const aborted = error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message))
    const message = connectTimedOut
      ? 'The download server did not respond.'
      : aborted
        ? 'Download cancelled.'
        : error instanceof Error
          ? error.message
          : String(error)
    await updateStoreEntry(game.id, { status: 'wishlist' }).catch(() => {})
    emit({
      jobId,
      gameId: game.id,
      gameName: game.name,
      step: 'error',
      message: 'Download failed',
      percent: 0,
      status: 'error',
      error: message
    })
    if (destDir) await fsp.rm(destDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/** Convert and install a dump/archive the user picked from disk. */
export async function startStoreLocalInstall(
  game: StoreGame,
  sourcePath: string,
  jobId: string,
  emit: Emit
): Promise<void> {
  const report = makeReport(jobId, game, emit)
  try {
    await updateStoreEntry(game.id, { status: 'downloading' })
    report('queued', `Preparing ${game.name}…`, 1)
    await installFromPath(game, sourcePath, jobId, emit, 0)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await updateStoreEntry(game.id, { status: 'wishlist' }).catch(() => {})
    emit({
      jobId,
      gameId: game.id,
      gameName: game.name,
      step: 'error',
      message: 'Install failed',
      percent: 0,
      status: 'error',
      error: message
    })
    throw error
  }
}

export function cancelStoreDownload(jobId: string): void {
  const controller = active.get(jobId)
  if (!controller) return
  controller.abort()
  active.delete(jobId)
}
