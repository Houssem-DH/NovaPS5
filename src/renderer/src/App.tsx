import { useEffect } from 'react'
import { useLibrary } from '@/store/useLibrary'
import { Sidebar } from '@/components/Sidebar'
import { LibraryView } from '@/components/LibraryView'
import { GameDetail } from '@/components/GameDetail'
import { SettingsView } from '@/components/SettingsView'
import { InstallDialog } from '@/components/InstallDialog'
import { BootstrapScreen } from '@/components/BootstrapScreen'

export default function App() {
  const { view, selectedId, load, refreshInfo, setInstalling, bootstrapped, setBootstrapped } = useLibrary()

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
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrapped])

  if (!bootstrapped) {
    return <BootstrapScreen onDone={() => setBootstrapped(true)} />
  }

  const showDetail = view === 'library' && !!selectedId

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="app-bg flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-8 py-8">
          {view === 'library' && (showDetail ? <GameDetail /> : <LibraryView />)}
          {view === 'settings' && <SettingsView />}
        </div>
      </main>
      <InstallDialog />
    </div>
  )
}
