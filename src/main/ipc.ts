import { ipcMain, dialog, BrowserWindow, shell, app } from 'electron'
import { randomUUID } from 'crypto'
import { listGames, removeGame, scanLibrary } from './library'
import { launchGame } from './launch'
import { installGame } from './pipeline/install'
import { detectDump } from './pipeline/dump'
import { findPython, pythonInvocation } from './python'
import { ensureRuntime, readRuntimeManifest } from './runtime'
import { setGamesDir } from './settings'
import { checkForUpdates, dismissWhatsNew, installNow, pendingWhatsNew, updateState } from './updater'
import { toolsDir, runtimeLibsDir, libraryRoot, gamesRoot, runtimeRepo, toolingPresent, APP_REPO } from './paths'
import type { AppInfo, ImportRequest } from '@shared/types'

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

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('app:info', () => appInfo())

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
      filters: [{ name: 'PS5 dump archive', extensions: ['zip', 'rar', '7z'] }]
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
}
