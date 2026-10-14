import { ipcMain, dialog, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { listGames, removeGame } from './library'
import { launchGame } from './launch'
import { installGame } from './pipeline/install'
import { detectDump } from './pipeline/dump'
import { findPython } from './python'
import { toolsDir, runtimeLibsDir, libraryRoot, toolingPresent } from './paths'
import type { AppInfo, ImportRequest } from '@shared/types'

async function appInfo(): Promise<AppInfo> {
  const { relinker, libs } = toolingPresent()
  return {
    toolsDir: toolsDir(),
    relinkerPresent: relinker,
    libsPresent: libs,
    pythonPath: await findPython(),
    libraryRoot: libraryRoot()
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
      filters: [{ name: 'PS5 dump archive', extensions: ['zip'] }]
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('library:detect', (_e, sourcePath: string) => detectDump(sourcePath))
  ipcMain.handle('library:list', () => listGames())
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
}
