import { useEffect } from 'react'
import { useLibrary } from '@/store/useLibrary'
import { Sidebar } from '@/components/Sidebar'
import { LibraryView } from '@/components/LibraryView'
import { GameDetail } from '@/components/GameDetail'
import { SettingsView } from '@/components/SettingsView'
import { InstallDialog } from '@/components/InstallDialog'

export default function App() {
  const { view, selectedId, load, refreshInfo, setInstalling } = useLibrary()

  useEffect(() => {
    void load()
    void refreshInfo()

    const unsubscribe = window.api.onInstallProgress((progress) => {
      setInstalling(progress)
      if (progress.status === 'done') void load()
    })
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const showDetail = view === 'library' && !!selectedId

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="app-bg flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-8 py-8">
          {view === 'settings' ? <SettingsView /> : showDetail ? <GameDetail /> : <LibraryView />}
        </div>
      </main>
      <InstallDialog />
    </div>
  )
}
