import { ipcMain, dialog, BrowserWindow, shell, app, screen } from 'electron'
import { randomUUID } from 'crypto'
import {
  clearShaderCache,
  getGame,
  listGames,
  removeGame,
  scanLibrary,
  setGameCompatibility,
  setGameGraphics
} from './library'
import { launchGame } from './launch'
import { readPerformanceProfile } from './performance'
import { readTrophyPackages } from './trophy'
import { readSession } from './session'
import { installGame } from './pipeline/install'
import { detectDump } from './pipeline/dump'
import { findPython, pythonInvocation } from './python'
import { ensureRuntime, readRuntimeManifest } from './runtime'
import { setGamesDir } from './settings'
import { checkForUpdates, dismissWhatsNew, installNow, pendingWhatsNew, updateState } from './updater'
import { toolsDir, runtimeLibsDir, libraryRoot, gamesRoot, runtimeRepo, toolingPresent, APP_REPO } from './paths'
import { STORE_GENRES, STORE_REGIONS, browsePsn, featuredPsn, searchPsn } from './store/psn'
import { invalidateCatalog, loadCatalog } from './store/catalog'
import {
  addStoreEntry,
  getStoreEntry,
  getStoreSettings,
  listStoreEntries,
  removeStoreEntry,
  setStoreDownloadUrl,
  updateStoreSettings
} from './store/library'
import { cancelStoreDownload, startStoreDownload, startStoreLocalInstall } from './store/download'
import type {
  AppInfo,
  GameCompatibility,
  GameGraphics,
  ImportRequest,
  StoreDownloadProgress,
  StoreGame,
  StoreSearchQuery,
  StoreSearchResult,
  StoreSettings
} from '@shared/types'

async function appInfo(): Promise<AppInfo> {
  const { relinker, libs } = toolingPresent()
  return {
    toolsDir: toolsDir(),
    appVersion: app.getVersion(),
    relinkerPresent: relinker,
    libsPresent: libs,
    pythonPath: await findPython(),
    pythonBundled: (await pythonInvocation())?.bundled ?? false,
    libraryRoot: libraryRoot(),
    gamesDir: gamesRoot(),
    runtimeVersion: readRuntimeManifest()?.version ?? null,
    runtimeRepo: runtimeRepo(),
    appRepo: APP_REPO
  }
}

function regionFor(settings: StoreSettings): (typeof STORE_REGIONS)[number] {
  return (
    STORE_REGIONS.find((r) => r.code === settings.region && r.language === settings.language) ??
    STORE_REGIONS.find((r) => r.code === settings.region) ??
    STORE_REGIONS[0]
  )
}

function normalizedName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Match the PSN search normalization so catalog hits line up with it. */
function searchableName(value: string): string {
  return value.toLowerCase().replace(/['’™®©]/g, '').replace(/\s+/g, ' ').trim()
}

/** Catalog entries win over remote metadata for the same title. */
function mergeCatalog(catalog: StoreGame[], games: StoreGame[]): StoreGame[] {
  const ids = new Set(catalog.map((game) => game.id))
  const names = new Set(catalog.map((game) => normalizedName(game.name)))
  return [
    ...catalog,
    ...games.filter((game) => !ids.has(game.id) && !names.has(normalizedName(game.name)))
  ]
}

function catalogMatchesGenre(game: StoreGame, genre: string | undefined): boolean {
  if (!genre) return true
  const label = STORE_GENRES.find((entry) => entry.key === genre)?.label.toLowerCase() ?? genre.toLowerCase()
  return game.genres.some((value) => value.toLowerCase() === label)
}

async function storeQuery(query: StoreSearchQuery = {}): Promise<StoreSearchResult> {
  const settings = await getStoreSettings()
  const region = regionFor(settings)

  let catalog: StoreGame[] = []
  let catalogError: string | undefined
  try {
    catalog = (await loadCatalog(settings)).filter((game) => catalogMatchesGenre(game, query.genre))
  } catch (error) {
    catalogError = `Games catalog: ${error instanceof Error ? error.message : String(error)}`
  }

  const size = Math.min(100, Math.max(1, Math.floor(query.size ?? 40)))
  const offset = Math.max(0, Math.floor(query.offset ?? 0))
  const text = query.text?.trim()

  try {
    const result = text ? await searchPsn(query, region) : await browsePsn(query, region)

    if (text) {
      const needle = searchableName(text)
      const matches = catalog.filter(
        (game) =>
          searchableName(game.name).includes(needle) ||
          searchableName(game.publisher ?? '').includes(needle)
      )
      return {
        ...result,
        games: mergeCatalog(matches, result.games),
        total: result.total + matches.length,
        error: catalogError ?? result.error
      }
    }

    // Only prepend the catalog on the first page, so "Load more" doesn't repeat it.
    return {
      ...result,
      games: offset > 0 ? result.games : mergeCatalog(catalog, result.games),
      total: result.total + catalog.length,
      error: catalogError ?? result.error
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // A configured catalog still gives the user a usable store when the
    // PlayStation Store is unreachable.
    if (catalog.length > 0) {
      return {
        games: catalog,
        total: catalog.length,
        offset: 0,
        size,
        hasMore: false,
        region: region.code,
        error: catalogError ?? `PlayStation Store unavailable: ${message}`
      }
    }
    throw error
  }
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('app:info', () => appInfo())

  ipcMain.handle('app:displays', () => {
    const primaryId = screen.getPrimaryDisplay().id
    return screen.getAllDisplays().map((display, index) => ({
      id: display.id,
      label: display.label || `Display ${index + 1}`,
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
      refreshRate: display.displayFrequency,
      scaleFactor: display.scaleFactor,
      primary: display.id === primaryId
    }))
  })

  ipcMain.handle('dialog:selectFolder', async () => {
    const win = getWindow()
    const options: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:selectZip', async () => {
    const win = getWindow()
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      filters: [
        {
          name: 'PS5 dump archive',
          extensions: ['zip', 'rar', '7z', 'tar', 'tgz', 'tar.gz', 'tar.xz', 'gz', 'xz']
        }
      ]
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('library:detect', (_e, sourcePath: string) => detectDump(sourcePath))
  ipcMain.handle('library:list', () => listGames())
  ipcMain.handle('library:scan', () => scanLibrary())
  ipcMain.handle('game:launch', (_e, id: string) => launchGame(id))
  ipcMain.handle('game:remove', async (_e, id: string) => {
    await removeGame(id)
    return { ok: true }
  })
  ipcMain.handle('game:setGraphics', (_e, id: string, patch: Partial<GameGraphics>) =>
    setGameGraphics(id, patch)
  )
  ipcMain.handle(
    'game:setCompatibility',
    (_e, id: string, patch: Partial<GameCompatibility>) => setGameCompatibility(id, patch)
  )
  ipcMain.handle('game:trophyPackage', async (_e, id: string) => {
    const game = await getGame(id)
    if (!game) throw new Error('Game not found in library.')
    return readTrophyPackages(game.installPath)
  })
  ipcMain.handle('game:clearShaderCache', (_e, id: string) => clearShaderCache(id))
  ipcMain.handle('game:session', (_e, id: string) => readSession(id))
  ipcMain.handle('game:performance', async (_e, id: string) => {
    const game = await getGame(id)
    if (!game) throw new Error('Game not found in library.')
    return readPerformanceProfile(game)
  })

  // Fire-and-forget install: report progress over a webContents event channel.
  ipcMain.handle('install:start', (_e, req: ImportRequest) => {
    const jobId = randomUUID()
    installGame(req.sourcePath, req.name, (progress) => {
      getWindow()?.webContents.send('install:progress', progress)
    }, jobId).catch(() => {
      // failures are surfaced to the renderer through the progress event
    })
    return { jobId }
  })

  // First-run bootstrap + on-launch runtime updates. Checklist steps stream
  // over bootstrap:step; the promise resolves with the final result.
  ipcMain.handle('bootstrap:run', () => {
    const win = getWindow()
    return ensureRuntime((step) => win?.webContents.send('bootstrap:step', step))
  })

  ipcMain.handle('settings:get', () => ({
    gamesDir: gamesRoot(),
    runtimeRepo: runtimeRepo()
  }))

  ipcMain.handle('settings:setGamesDir', (_e, dir: string) => setGamesDir(dir))

  // ---- Application updates --------------------------------------------------
  ipcMain.handle('update:state', () => updateState())
  ipcMain.handle('update:check', () => checkForUpdates(true))
  ipcMain.handle('update:install', () => {
    installNow()
    return { ok: true }
  })
  ipcMain.handle('update:whatsNew', () => pendingWhatsNew())
  ipcMain.handle('update:dismissWhatsNew', () => {
    dismissWhatsNew()
    return { ok: true }
  })
  ipcMain.handle('app:openExternal', async (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })
  ipcMain.handle('app:openDisplaySettings', async () => {
    // Windows only: the app is packaged for Windows and this is the built-in
    // page where the user can raise the refresh rate that gates AnyPS5's
    // 119.88 Hz output mode.
    if (process.platform === 'win32') await shell.openExternal('ms-settings:display')
  })

  // ---- Store ----------------------------------------------------------------
  ipcMain.handle('store:regions', () => STORE_REGIONS)
  ipcMain.handle('store:settings:get', () => getStoreSettings())
  ipcMain.handle('store:settings:set', async (_e, patch: Partial<StoreSettings>) => {
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'catalogUrl')) invalidateCatalog()
    return updateStoreSettings(patch)
  })
  ipcMain.handle('store:browse', (_e, query?: StoreSearchQuery) => storeQuery(query ?? {}))
  ipcMain.handle('store:search', (_e, query?: StoreSearchQuery) => storeQuery(query ?? {}))
  ipcMain.handle('store:featured', async () => {
    const settings = await getStoreSettings()
    const region = regionFor(settings)
    let catalog: StoreGame[] = []
    try {
      catalog = await loadCatalog(settings)
    } catch {
      // The remote catalog is optional; the PS Store list still stands alone.
    }
    const featured = await featuredPsn(region).catch(() => [])
    return mergeCatalog(catalog.slice(0, 6), featured).slice(0, 10)
  })
  ipcMain.handle('store:library:list', () => listStoreEntries())
  ipcMain.handle('store:add', (_e, game: StoreGame) => addStoreEntry(game))
  ipcMain.handle('store:remove', (_e, id: string) => removeStoreEntry(id))
  ipcMain.handle('store:setDownload', (_e, id: string, url: string | null) =>
    setStoreDownloadUrl(id, url)
  )
  ipcMain.handle('store:download', async (_e, id: string, url?: string) => {
    const entry = await getStoreEntry(id)
    if (!entry) throw new Error('Add this game to your library first.')
    const candidate = url?.trim() ?? ''
    if (candidate) await setStoreDownloadUrl(id, candidate)
    const target = (candidate || entry.game.downloadUrl || '').trim()
    if (!target) {
      throw new Error('This game has no download URL. Attach one you host, or install from a file.')
    }
    const jobId = randomUUID()
    const send = (progress: StoreDownloadProgress): void => {
      getWindow()?.webContents.send('store:progress', progress)
    }
    startStoreDownload(entry.game, target, jobId, send).catch(() => {
      // failures are surfaced through store:progress
    })
    return { jobId }
  })
  ipcMain.handle('store:installLocal', async (_e, id: string, sourcePath: string) => {
    const entry = await getStoreEntry(id)
    if (!entry) throw new Error('Add this game to your library first.')
    const jobId = randomUUID()
    const send = (progress: StoreDownloadProgress): void => {
      getWindow()?.webContents.send('store:progress', progress)
    }
    startStoreLocalInstall(entry.game, sourcePath, jobId, send).catch(() => {
      // failures are surfaced through store:progress
    })
    return { jobId }
  })
  ipcMain.handle('store:cancel', (_e, jobId: string) => {
    cancelStoreDownload(jobId)
    return { ok: true }
  })
}
