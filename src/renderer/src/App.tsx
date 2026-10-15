import { useEffect } from 'react'
import { useLibrary } from '@/store/useLibrary'
import { Sidebar } from '@/components/Sidebar'
import { LibraryView } from '@/components/LibraryView'
import { GameDetail } from '@/components/GameDetail'
import { SettingsView } from '@/components/SettingsView'
import { InstallDialog } from '@/components/InstallDialog'
import { UpdateButton } from '@/components/UpdateButton'
import { UpdateDialog } from '@/components/UpdateDialog'
import { BootstrapScreen } from '@/components/BootstrapScreen'

/** Frameless-window title bar: drags the window; the OS controls sit on top-right. */
function TitleBar() {
  return (
    <div className="drag-region flex h-10 shrink-0 items-center gap-2.5 border-b border-border/60 bg-card/40 px-4 backdrop-blur-sm">
      <img src="icon.png" alt="" draggable={false} className="h-[18px] w-[18px] shrink-0 select-none rounded-[5px]" />
      <span className="text-xs font-semibold tracking-tight">
        Nova<span className="text-primary">PS5</span>
      </span>
      {/* Leaves room for the native window controls pinned to the top-right. */}
      <div className="mr-[9.5rem] ml-auto">
        <UpdateButton />
      </div>
    </div>
  )
}

export default function App() {
  const {
    view,
    selectedId,
    load,
    refreshInfo,
    setInstalling,
    bootstrapped,
    setBootstrapped,
    setInstallOpen,
    setUpdate,
    setUpdateOpen,
    checkWhatsNew
  } = useLibrary()

  useEffect(() => {
    // Library IO waits for the runtime bootstrap — the checklist screen owns
    // the window until the tooling is guaranteed present.
    if (!bootstrapped) return

    void load()
    void refreshInfo()
    // An update installed by the previous run leaves its release notes behind.
    void checkWhatsNew()
    void window.api.updateState().then(setUpdate)

    const unsubscribe = window.api.onInstallProgress((progress) => {
      setInstalling(progress)
      if (progress.status === 'done') void load()
    })
    const unsubscribeInstall = window.api.onOpenInstall(() => setInstallOpen(true))
    const unsubscribeUpdate = window.api.onUpdateState((next) => {
      setUpdate(next)
      // A check started from the tray or the File menu should show its result.
      if (next.manual && (next.status === 'available' || next.status === 'downloading')) setUpdateOpen(true)
    })
    return () => {
      unsubscribe()
      unsubscribeInstall()
      unsubscribeUpdate()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrapped])

  if (!bootstrapped) {
    return <BootstrapScreen onDone={() => setBootstrapped(true)} />
  }

  const showDetail = view === 'library' && !!selectedId

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TitleBar />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar />
        <main className="app-bg flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl px-8 py-8">
            {view === 'library' && (showDetail ? <GameDetail /> : <LibraryView />)}
            {view === 'settings' && <SettingsView />}
          </div>
        </main>
      </div>
      <InstallDialog />
      <UpdateDialog />
    </div>
  )
}
