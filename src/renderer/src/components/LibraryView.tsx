import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { useLibrary } from '@/store/useLibrary'
import { GameGrid } from './GameGrid'
import { EmptyState } from './EmptyState'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'

export function LibraryView() {
  const { games, loading } = useLibrary()
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return games
    return games.filter(
      (game) =>
        game.name.toLowerCase().includes(q) || (game.titleId ?? '').toLowerCase().includes(q)
    )
  }, [games, query])

  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="aspect-[3/4] rounded-xl" />
        ))}
      </div>
    )
  }

  if (games.length === 0) {
    return <EmptyState />
  }

  return (
    <div>
      <header className="mb-7 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Library</h1>
          <p className="text-sm text-muted-foreground">
            {games.length} installed {games.length === 1 ? 'game' : 'games'}
          </p>
        </div>
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or title ID…"
            className="pl-9"
          />
        </div>
      </header>

      {filtered.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">No games match “{query}”.</p>
      ) : (
        <GameGrid games={filtered} />
      )}
    </div>
  )
}
