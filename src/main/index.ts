import { app, BrowserWindow, Menu, Tray, nativeImage, protocol, screen } from 'electron'
import path from 'path'
import fs from 'fs'
import { registerIpc } from './ipc'
import { gamesRoot, ensureDir } from './paths'
import { getGame } from './library'
import { initUpdater, checkForUpdates } from './updater'
import { beginQuit, isQuitting } from './lifecycle'

// Must be registered before app ready. media:// serves cover images out of the
// library folder without exposing the whole filesystem to the renderer.
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
/** The "still running in the tray" hint is shown once per session. */
let trayHintShown = false

/** Square brand icon used for the window and the tray. */
function iconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(app.getAppPath(), 'public', 'icon.png')
}

const iconFile = (): string =>
  app.isPackaged ? path.join(process.resourcesPath, 'icon.ico') : path.join(app.getAppPath(), 'build', 'icon.ico')

function showWindow(): void {
  if (!mainWindow) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

/** Parks the window in the tray (no taskbar button) while the app keeps running. */
function hideToTray(): void {
  mainWindow?.hide()
  if (trayHintShown || !tray) return
  trayHintShown = true
  try {
    tray.displayBalloon({
      title: 'NovaPS5 is still running',
      content: 'Click the tray icon to bring the window back — Quit in its menu closes the app.'
    })
  } catch {
    // balloons are unsupported on some shells; never let that break the hide
  }
}

function askInstall(): void {
  showWindow()
  mainWindow?.webContents.send('ui:install')
}

function createWindow(): void {
  // Fit inside the screen's work area (a fixed 1280x820 would look maximized on
  // smaller displays and could not be dragged).
  const { workAreaSize } = screen.getPrimaryDisplay()
  const width = Math.min(1280, Math.max(980, workAreaSize.width - 48))
  const height = Math.min(820, Math.max(620, workAreaSize.height - 48))

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(980, width),
    minHeight: Math.min(620, height),
    center: true,
    show: false,
    backgroundColor: '#09090b',
    icon: fs.existsSync(iconFile()) ? iconFile() : iconPath(),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#09090b', symbolColor: '#a1a1aa', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // Closing the window keeps NovaPS5 alive: the window is parked in the tray so
  // a click on the tray icon brings it straight back. Quit from the tray menu,
  // File ▸ Quit (Ctrl+Q), or the tray icon to really exit.
  mainWindow.on('close', (event) => {
    if (isQuitting()) return
    event.preventDefault()
    hideToTray()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function createTray(): void {
  try {
    const source = fs.existsSync(iconFile()) ? iconFile() : iconPath()
    const image = nativeImage.createFromPath(source)
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }))
    tray.setToolTip('NovaPS5')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open NovaPS5', click: showWindow },
        { label: 'Install a game…', click: askInstall },
        { label: 'Check for updates…', click: () => void checkForUpdates(true) },
        { type: 'separator' },
        {
          label: 'Quit NovaPS5',
          click: () => {
            beginQuit()
            app.quit()
          }
        }
      ])
    )
    tray.on('double-click', showWindow)
    tray.on('click', showWindow)
  } catch {
    tray = null // a tray is a convenience — never block startup over it
  }
}

function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'File',
        submenu: [
          { label: 'Install a game…', accelerator: 'CmdOrCtrl+O', click: askInstall },
          { label: 'Check for updates…', click: () => void checkForUpdates(true) },
          { type: 'separator' },
          {
            label: 'Quit NovaPS5',
            accelerator: 'CmdOrCtrl+Q',
            click: () => {
              beginQuit()
              app.quit()
            }
          }
        ]
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' }
        ]
      }
    ])
  )
}

function registerMediaProtocol(): void {
  protocol.handle('media', async (request) => {
    try {
      const url = new URL(request.url)
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      const [id, ...rest] = rel.split('/').filter(Boolean)
      if (!id || rest.length === 0) return new Response('not found', { status: 404 })

      const game = await getGame(id)
      if (!game) return new Response('not found', { status: 404 })

      const root = path.resolve(game.installPath)
      const full = path.resolve(root, rest.join('/'))
      if (full !== root && !full.startsWith(root + path.sep)) return new Response('forbidden', { status: 403 })

      const data = fs.readFileSync(full)
      const ext = path.extname(full).toLowerCase()
      const type =
        ext === '.png'
          ? 'image/png'
          : ext === '.jpg' || ext === '.jpeg'
            ? 'image/jpeg'
            : 'application/octet-stream'
      return new Response(new Uint8Array(data), { headers: { 'Content-Type': type } })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}

// A second launch (e.g. clicking the desktop shortcut again) focuses the window
// we already have instead of starting another copy.
const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  // Taskbar identity — without this Windows groups the app under a generic
  // Electron entry and the shortcut icon can be ignored.
  app.setAppUserModelId('com.novaps5.app')

  app.whenReady().then(() => {
    registerMediaProtocol()

    ensureDir(gamesRoot())
    registerIpc(() => mainWindow)
    buildMenu()
    createWindow()
    createTray()
    initUpdater(() => mainWindow)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else showWindow()
    })
  })
}

app.on('before-quit', () => {
  beginQuit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
