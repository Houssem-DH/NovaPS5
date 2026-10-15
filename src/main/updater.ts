// App self-update: checks the GitHub releases of this repository, downloads the
// signed-off NSIS installer in the background, installs it and restarts NovaPS5.
//
// The release notes of the update that was just installed are written to disk
// before restarting, so the relaunched app can open a "What's new" dialog with
// the version that landed and the notes the maintainer typed on GitHub.

import { app, BrowserWindow } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import fs from 'node:fs'
import path from 'node:path'
import type { UpdateState, WhatsNew } from '@shared/types'
import { beginQuit, cancelQuit } from './lifecycle'

interface PendingNotice {
  version: string
  from?: string
  notes: string
  at: number
}

interface UpdateStore {
  /** Set when an update finished downloading; read once after the restart. */
  notice?: PendingNotice
  lastCheckAt?: number
}

/** How long the "restarting to update" state is shown before we install. */
const RESTART_DELAY_MS = 4000

/**
 * `npm run dev` builds are not installed, so electron-updater refuses to check
 * by default. Set NOVAPS5_DEV_UPDATES=1 to exercise the real check (reads
 * dev-app-update.yml) — used while developing the update flow itself.
 */
const DEV_UPDATES = process.env.NOVAPS5_DEV_UPDATES === '1'
/** Checks can only run in an installed build (or a forced dev session). */
const CAN_CHECK = (): boolean => app.isPackaged || DEV_UPDATES

let getWindow: (() => BrowserWindow | null) | null = null
let state: UpdateState = { status: 'idle', currentVersion: app.getVersion() }
let checking: Promise<UpdateState> | null = null
let restartTimer: NodeJS.Timeout | null = null

function storePath(): string {
  return path.join(app.getPath('userData'), 'updates.json')
}

function readStore(): UpdateStore {
  try {
    // Tolerate a UTF-8 BOM: the file may have been edited by hand.
    const raw = fs.readFileSync(storePath(), 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(raw) as UpdateStore
  } catch {
    return {}
  }
}

function writeStore(store: UpdateStore): void {
  try {
    const file = storePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2))
    fs.renameSync(tmp, file)
  } catch {
    // the update itself must never fail because of a note we could not save
  }
}

function publish(patch: Partial<UpdateState>): UpdateState {
  state = { ...state, currentVersion: app.getVersion(), ...patch }
  getWindow?.()?.webContents.send('update:state', state)
  return state
}

export function updateState(): UpdateState {
  return state
}

/** electron-updater reports notes either as one blob or per version. */
function notesOf(info: UpdateInfo): string {
  const notes = info.releaseNotes
  if (!notes) return ''
  if (typeof notes === 'string') return notes
  return notes
    .map((entry) => (entry.version ? `## ${entry.version}\n\n${entry.note ?? ''}` : (entry.note ?? '')))
    .join('\n\n')
    .trim()
}

/** Turns electron-updater's developer-facing errors into something readable. */
function explain(error: unknown): { status: 'current' | 'error'; message: string; detail?: string } {
  const raw = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: string } | null)?.code ?? ''

  // Nothing has been published yet (or only a tag exists, without a release).
  if (
    code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' ||
    code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' ||
    /no published versions|unable to find latest version|production release exists/i.test(raw)
  ) {
    return {
      status: 'current',
      message: 'No updates published yet',
      detail: 'There is no published NovaPS5 release to compare this version with yet.'
    }
  }
  if (/ENOTFOUND|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ENETUNREACH|ERR_PROXY/i.test(raw)) {
    return {
      status: 'error',
      message: 'No internet connection',
      detail: 'NovaPS5 could not reach GitHub to look for updates.'
    }
  }
  if (/ETIMEDOUT|timeout|ERR_CONNECTION/i.test(raw)) {
    return { status: 'error', message: 'Update check timed out', detail: 'The update server did not answer in time.' }
  }
  if (
    code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' ||
    code === 'ERR_UPDATER_INVALID_UPDATE_INFO' ||
    code === 'ERR_UPDATER_INVALID_RELEASE_FEED'
  ) {
    return {
      status: 'error',
      message: 'Release is incomplete',
      detail:
        'The GitHub release is missing its latest.yml update file, so NovaPS5 cannot verify the download. ' +
        'Attach NovaPS5-Setup-<version>.exe, latest.yml and its .blockmap to the release.'
    }
  }
  if (code === 'ERR_UPDATER_INVALID_SIGNATURE') {
    return {
      status: 'error',
      message: 'Update could not be verified',
      detail: 'The downloaded installer does not match what the release published.'
    }
  }
  if (/not packed|dev update config|dev-app-update/i.test(raw)) {
    return { status: 'current', message: 'Update checks are for installed builds' }
  }
  return {
    status: 'error',
    message: 'Could not check for updates',
    detail: raw.length > 300 ? `${raw.slice(0, 300)}…` : raw
  }
}

function scheduleRestart(version: string): void {
  if (restartTimer) return
  publish({ status: 'installing', message: `Restarting to install v${version}…`, percent: 100 })
  restartTimer = setTimeout(() => {
    restartTimer = null
    installNow()
  }, RESTART_DELAY_MS)
}

/** Quits into the downloaded installer; the app comes back on the new version. */
export function installNow(): void {
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  try {
    beginQuit() // our window intercepts close to minimize — not during an update
    // (isSilent, isForceRunAfter): install quietly and relaunch when done.
    autoUpdater.quitAndInstall(true, true)
    // If the installer never took over, keep the app usable.
    setTimeout(cancelQuit, 20000)
  } catch (error) {
    cancelQuit()
    publish({ status: 'error', message: 'Could not start the installer', detail: String(error) })
  }
}

export function initUpdater(window: () => BrowserWindow | null): void {
  getWindow = window
  state = { status: 'idle', currentVersion: app.getVersion() }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  if (DEV_UPDATES) autoUpdater.forceDevUpdateConfig = true
  // Builds are not code-signed, so there is no publisher name to verify against;
  // the installer still comes over HTTPS from this project's GitHub releases.
  ;(autoUpdater as unknown as { verifyUpdateCodeSignature: boolean }).verifyUpdateCodeSignature = false

  autoUpdater.on('checking-for-update', () => publish({ status: 'checking', message: 'Checking for updates…' }))

  autoUpdater.on('update-available', (info) => {
    publish({
      status: 'available',
      version: info.version,
      notes: notesOf(info),
      percent: 0,
      message: `NovaPS5 v${info.version} is available`
    })
  })

  autoUpdater.on('update-not-available', () => {
    const store = readStore()
    store.lastCheckAt = Date.now()
    writeStore(store)
    publish({
      status: 'current',
      message: state.manual ? "You're on the latest version" : 'Up to date',
      percent: undefined
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    publish({
      status: 'downloading',
      percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
      message: `Downloading update… ${Math.round(progress.percent)}%`
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    // Remember what changed so the relaunched app can show it.
    const store = readStore()
    store.notice = {
      version: info.version,
      from: app.getVersion(),
      notes: notesOf(info),
      at: Date.now()
    }
    store.lastCheckAt = Date.now()
    writeStore(store)
    publish({
      status: 'ready',
      version: info.version,
      notes: notesOf(info),
      percent: 100,
      message: `NovaPS5 v${info.version} downloaded`
    })
    scheduleRestart(info.version)
  })

  autoUpdater.on('error', (error) => {
    const result = explain(error)
    publish({ status: result.status, message: result.message, detail: result.detail })
  })

  // Check on every launch, a few seconds in so it never delays the first paint.
  if (CAN_CHECK()) {
    setTimeout(() => void checkForUpdates(false), 4000)
  }
}

export async function checkForUpdates(manual: boolean): Promise<UpdateState> {
  if (!CAN_CHECK()) {
    // A source build has no install to replace — say so instead of pretending
    // to have compared versions.
    return publish({
      status: 'current',
      message: 'Update checks are for installed builds',
      detail: 'Install NovaPS5 with its installer to receive updates automatically.',
      manual,
      percent: undefined
    })
  }

  if (checking) return checking

  publish({ status: 'checking', message: 'Checking for updates…', manual })

  checking = (async () => {
    try {
      const result = await autoUpdater.checkForUpdates()
      // Version comparisons arrive through the events above; make sure a silent
      // check that produced no event still leaves a usable state behind.
      if (!result && state.status === 'checking') {
        publish({ status: 'current', message: 'Up to date' })
      }
    } catch (error) {
      const result = explain(error)
      publish({ status: result.status, message: result.message, detail: result.detail })
    } finally {
      checking = null
    }
    if (state.status === 'checking') publish({ status: 'current', message: 'Up to date' })
    return state
  })()

  return checking
}

/**
 * Release notes of the update installed by the last restart — only when the
 * running version is the one we recorded, so a stale note is never shown.
 */
export function pendingWhatsNew(): WhatsNew | null {
  const store = readStore()
  const notice = store.notice
  if (!notice) return null

  if (notice.version !== app.getVersion()) {
    delete store.notice
    writeStore(store)
    return null
  }
  return { version: notice.version, from: notice.from, notes: notice.notes }
}

export function dismissWhatsNew(): void {
  const store = readStore()
  delete store.notice
  writeStore(store)
}
