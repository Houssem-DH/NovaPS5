import { useEffect } from 'react'
import { useLibrary } from '@/store/useLibrary'
import { Sidebar } from '@/components/Sidebar'
import { LibraryView } from '@/components/LibraryView'
import { GameDetail } from '@/components/GameDetail'
import { SettingsView } from '@/components/SettingsView'
import { InstallDialog } from '@/components/InstallDialog'
import { BootstrapScreen } from '@/components/BootstrapScreen'

/** Frameless-window title bar: drags the window; the OS controls sit on top-right. */
function TitleBar() {
  return (
    <div className="drag-region flex h-10 shrink-0 items-center gap-2.5 border-b border-border/60 bg-card/40 px-4 backdrop-blur-sm">
      <img src="icon.png" alt="" draggable={false} className="h-4 w-4 select-none" />
      <span className="text-xs font-semibold tracking-tight">
        Nova<span className="text-primary">PS5</span>
      </span>
      <span className="ml-auto mr-[9.5rem] hidden text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground/50 md:block">
        Nova Crafted
      </span>
    </div>
  )
}

export default function App() {
  const { view, selectedId, load, refreshInfo, setInstalling, bootstrapped, setBootstrapped, setInstallOpen } =
    useLibrary()

  useEffect(() => {
    // Library IO waits for the runtime bootstrap — the checklist screen owns
    // the window until the tooling is guaranteed present.
    if (!bootstrapped) return

    void load()
    void refreshInfo()

    const unsubscribe = window.api.onInstallProgress((progress) => {
      setInstalling(progress)
      if (progress.status === 'done') void load()
    })
    const unsubscribeInstall = window.api.onOpenInstall(() => setInstallOpen(true))
    return () => {
      unsubscribe()
      unsubscribeInstall()
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
    </div>
  )
}
