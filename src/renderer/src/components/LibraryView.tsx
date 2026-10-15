import { useMemo, useState } from 'react'
import { Plus, RefreshCw, Search } from 'lucide-react'
import { useLibrary } from '@/store/useLibrary'
import { GameGrid } from './GameGrid'
import { EmptyState } from './EmptyState'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

export function LibraryView() {
  const { games, loading, scan, setInstallOpen } = useLibrary()
  const [query, setQuery] = useState('')
  const [scanning, setScanning] = useState(false)
  const [scanMsg, setScanMsg] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return games
    return games.filter(
      (game) =>
        game.name.toLowerCase().includes(q) || (game.titleId ?? '').toLowerCase().includes(q)
    )
  }, [games, query])

  const runScan = async (): Promise<void> => {
    setScanning(true)
    setScanMsg(null)
    try {
      const { summary } = await scan()
      const parts: string[] = []
      if (summary.added > 0) parts.push(`${summary.added} new`)
      if (summary.repaired > 0) parts.push(`${summary.repaired} restored`)
      if (summary.missing > 0) parts.push(`${summary.missing} missing`)
      setScanMsg(
        parts.length > 0 ? `Scan complete — ${parts.join(', ')}.` : 'Scan complete — everything is up to date.'
      )
    } catch (error) {
      setScanMsg(error instanceof Error ? error.message : 'Scan failed.')
    }
    setScanning(false)
  }

  if (loading) {
    return (
      <div>
        <Header count={null} query={query} onQuery={setQuery} onScan={runScan} scanning={scanning} scanMsg={null} />
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="aspect-[3/4] rounded-2xl" />
          ))}
        </div>
      </div>
    )
  }

  if (games.length === 0) {
    return (
      <div>
        <Header count={0} query={query} onQuery={setQuery} onScan={runScan} scanning={scanning} scanMsg={scanMsg} />
        <EmptyState />
      </div>
    )
  }

  return (
    <div>
      <Header
        count={games.length}
        query={query}
        onQuery={setQuery}
        onScan={runScan}
        scanning={scanning}
        scanMsg={scanMsg}
      />

      {filtered.length === 0 ? (
        <div className="panel flex flex-col items-center gap-3 py-16 text-center">
          <p className="text-sm text-muted-foreground">No games match “{query}”.</p>
          <Button variant="outline" size="sm" onClick={() => setQuery('')}>
            Clear search
          </Button>
        </div>
      ) : (
        <GameGrid games={filtered} />
      )}

      <div className="mt-10 flex justify-center">
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setInstallOpen(true)}>
          <Plus className="h-4 w-4" /> Install another game
        </Button>
      </div>
    </div>
  )
}

function Header({
  count,
  query,
  onQuery,
  onScan,
  scanning,
  scanMsg
}: {
  count: number | null
  query: string
  onQuery: (value: string) => void
  onScan: () => void
  scanning: boolean
  scanMsg: string | null
}) {
  return (
    <header className="mb-7">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Library</h1>
          <p className="text-sm text-muted-foreground">
            {count === null
              ? 'Loading your games…'
              : `${count} installed ${count === 1 ? 'game' : 'games'}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative w-60">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder="Search by name or title ID…"
              className="pl-9"
            />
          </div>
          <Button variant="outline" onClick={onScan} disabled={scanning} title="Re-read the library from disk">
            <RefreshCw className={cn('h-4 w-4', scanning && 'animate-spin')} />
            {scanning ? 'Scanning…' : 'Scan'}
          </Button>
        </div>
      </div>
      {scanMsg && (
        <p className="mt-3 text-xs text-muted-foreground" role="status">
          {scanMsg}
        </p>
      )}
    </header>
  )
}
