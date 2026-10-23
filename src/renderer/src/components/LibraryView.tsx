import { useEffect, useMemo, useState } from 'react'
import { Download, LayoutGrid, Plus, RefreshCw, Search } from 'lucide-react'
import { useLibrary } from '@/store/useLibrary'
import { useStore } from '@/store/useStore'
import type { LucideIcon } from 'lucide-react'
import { GameCard } from './GameCard'
import { WishlistGameCard } from './WishlistGameCard'
import { EmptyState } from './EmptyState'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

type Filter = 'all' | 'installed' | 'wishlist'

const GRID = 'grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5'

/** Loose title key so store entries and installs of the same game line up. */
function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/\b(ps4|ps5)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function LibraryView() {
  const { games, loading, scan, setInstallOpen } = useLibrary()
  const entries = useStore((state) => state.entries)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [scanning, setScanning] = useState(false)
  const [scanMsg, setScanMsg] = useState<string | null>(null)

  useEffect(() => {
    // Keep the "not installed" shelf in sync if it changed elsewhere.
    void useStore.getState().refreshLibrary().catch(() => {})
  }, [])

  // Games saved in the catalog library that are not on disk yet. An entry is
  // hidden as soon as a matching install exists (by id, title id, or title).
  const wishlist = useMemo(() => {
    const installedIds = new Set(games.map((game) => game.id))
    const installedTitleIds = new Set(
      games.map((game) => game.titleId).filter((value): value is string => Boolean(value))
    )
    const installedNames = new Set(games.map((game) => normalizeName(game.name)))
    const seen = new Set<string>()

    return entries.filter((entry) => {
      if (entry.status === 'installed') return false
      if (entry.installedGameId && installedIds.has(entry.installedGameId)) return false

      const titleId = entry.game.titleId
      if (titleId && installedTitleIds.has(titleId)) return false

      const nameKey = normalizeName(entry.game.name)
      if (nameKey && installedNames.has(nameKey)) return false

      const key = titleId || nameKey || entry.game.id
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [entries, games])

  const needle = query.trim().toLowerCase()

  const installed = useMemo(() => {
    if (!needle) return games
    return games.filter(
      (game) =>
        game.name.toLowerCase().includes(needle) ||
        (game.titleId ?? '').toLowerCase().includes(needle)
    )
  }, [games, needle])

  const pending = useMemo(() => {
    if (!needle) return wishlist
    return wishlist.filter(
      (entry) =>
        entry.game.name.toLowerCase().includes(needle) ||
        (entry.game.titleId ?? '').toLowerCase().includes(needle) ||
        (entry.game.publisher ?? '').toLowerCase().includes(needle)
    )
  }, [wishlist, needle])

  const showInstalled = filter !== 'wishlist' ? installed : []
  const showPending = filter !== 'installed' ? pending : []
  const visible = showInstalled.length + showPending.length

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

  const header = (
    <Header
      installedCount={games.length}
      wishlistCount={wishlist.length}
      loading={loading}
      query={query}
      onQuery={setQuery}
      onScan={runScan}
      scanning={scanning}
      scanMsg={scanMsg}
      filter={filter}
      onFilter={setFilter}
    />
  )

  if (loading) {
    return (
      <div>
        {header}
        <div className={GRID}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="aspect-[3/4] rounded-2xl" />
          ))}
        </div>
      </div>
    )
  }

  if (games.length === 0 && wishlist.length === 0) {
    return (
      <div>
        {header}
        <EmptyState />
      </div>
    )
  }

  return (
    <div>
      {header}

      {visible === 0 ? (
        <div className="panel flex flex-col items-center gap-3 py-16 text-center">
          <p className="text-sm text-muted-foreground">
            {needle
              ? `No games match “${query}”.`
              : filter === 'installed'
                ? 'Nothing installed yet — games you save from the catalog will show here as not installed.'
                : 'Every game in your library is installed.'}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setQuery('')
              setFilter('all')
            }}
          >
            Show all games
          </Button>
        </div>
      ) : (
        <div className={GRID}>
          {showInstalled.map((game, index) => (
            <GameCard key={game.id} game={game} index={index} />
          ))}
          {showPending.map((entry, index) => (
            <WishlistGameCard key={entry.game.id} entry={entry} index={showInstalled.length + index} />
          ))}
        </div>
      )}

      <div className="mt-10 flex justify-center">
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setInstallOpen(true)}>
          <Plus className="h-4 w-4" /> Install another game
        </Button>
      </div>
    </div>
  )
}

function Tab({
  icon: Icon,
  label,
  count,
  active,
  onClick
}: {
  icon: LucideIcon
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
        active ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
      <span
        className={cn(
          'rounded-full px-1.5 text-[11px] tabular-nums',
          active ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground'
        )}
      >
        {count}
      </span>
    </button>
  )
}

function Header({
  installedCount,
  wishlistCount,
  loading,
  query,
  onQuery,
  onScan,
  scanning,
  scanMsg,
  filter,
  onFilter
}: {
  installedCount: number
  wishlistCount: number
  loading: boolean
  query: string
  onQuery: (value: string) => void
  onScan: () => void
  scanning: boolean
  scanMsg: string | null
  filter: Filter
  onFilter: (filter: Filter) => void
}) {
  const total = installedCount + wishlistCount
  return (
    <header className="mb-7">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Library</h1>
          <p className="text-sm text-muted-foreground">
            {loading
              ? 'Loading your games…'
              : `${installedCount} installed${
                  wishlistCount > 0 ? ` · ${wishlistCount} not installed` : ''
                }`}
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

      <div className="mt-5 flex w-fit items-center gap-1 rounded-xl border border-border/60 bg-secondary/30 p-1">
        <Tab icon={LayoutGrid} label="All" count={total} active={filter === 'all'} onClick={() => onFilter('all')} />
        <Tab
          icon={LayoutGrid}
          label="Installed"
          count={installedCount}
          active={filter === 'installed'}
          onClick={() => onFilter('installed')}
        />
        <Tab
          icon={Download}
          label="Not installed"
          count={wishlistCount}
          active={filter === 'wishlist'}
          onClick={() => onFilter('wishlist')}
        />
      </div>

      {scanMsg && (
        <p className="mt-3 text-xs text-muted-foreground" role="status">
          {scanMsg}
        </p>
      )}
    </header>
  )
}
