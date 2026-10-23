import { useEffect, useRef, useState } from 'react'
import {
  Compass,
  Library,
  Loader2,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Gamepad2,
  WifiOff,
  X
} from 'lucide-react'
import type { StoreGame } from '@shared/types'
import { useStore } from '@/store/useStore'
import { StoreGameCard } from './StoreGameCard'
import { StoreSettingsDialog } from './StoreSettingsDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

const GENRES = [
  { key: '', label: 'All' },
  { key: 'action', label: 'Action' },
  { key: 'adventure', label: 'Adventure' },
  { key: 'role_playing_games', label: 'RPG' },
  { key: 'shooter', label: 'Shooter' },
  { key: 'racing', label: 'Racing' },
  { key: 'sports', label: 'Sports' },
  { key: 'horror', label: 'Horror' },
  { key: 'puzzle', label: 'Puzzle' },
  { key: 'simulation', label: 'Simulation' },
  { key: 'strategy', label: 'Strategy' },
  { key: 'fighting', label: 'Fighting' },
  { key: 'family', label: 'Family' }
]

function yearOf(game: StoreGame): number | null {
  if (!game.releaseDate) return null
  const date = new Date(game.releaseDate)
  return Number.isNaN(date.getTime()) ? null : date.getFullYear()
}

function GridSkeleton(): JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
      {Array.from({ length: 10 }).map((_, index) => (
        <div key={index} className="space-y-2">
          <Skeleton className="aspect-[3/4] w-full rounded-2xl" />
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  )
}

function Featured({
  games,
  onOpen
}: {
  games: StoreGame[]
  onOpen: (game: StoreGame) => void
}): JSX.Element | null {
  if (!games.length) return null
  const [hero, ...rest] = games
  const art = hero.heroUrl ?? hero.coverUrl
  const year = yearOf(hero)

  return (
    <section className="mb-8 overflow-hidden rounded-2xl border border-border/60 bg-card">
      <div className="relative min-h-[280px]">
        {art ? (
          <img src={art} alt="" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <div className="cover-fallback absolute inset-0" />
        )}
        <div className="absolute inset-0 bg-gradient-to-r from-card via-card/85 to-card/10" />
        <div className="absolute inset-0 bg-gradient-to-t from-card/90 via-transparent to-transparent" />

        <div className="relative flex max-w-lg flex-col gap-3 p-6 sm:p-8">
          <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary">
            <Sparkles className="h-3 w-3" /> Featured
          </span>
          <h2 className="text-3xl font-semibold tracking-tight">{hero.name}</h2>
          <p className="text-sm text-muted-foreground">
            {hero.publisher ?? 'PS5'}
            {year ? ` · ${year}` : ''}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <Button onClick={() => onOpen(hero)}>
              <Compass /> View game
            </Button>
          </div>
        </div>
      </div>

      {rest.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 border-t border-border/60 p-3 sm:grid-cols-4">
          {rest.slice(0, 4).map((game) => (
            <button
              key={game.id}
              onClick={() => onOpen(game)}
              className="group flex items-center gap-3 rounded-xl p-2 text-left transition-colors hover:bg-accent/60"
            >
              <div className="h-14 w-11 shrink-0 overflow-hidden rounded-md border border-border/60 bg-secondary">
                {game.coverUrl ? (
                  <img src={game.coverUrl} alt="" className="h-full w-full object-cover" />
                ) : null}
              </div>
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold">{game.name}</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {game.publisher ?? 'PS5'}
                </div>
              </div>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  )
}

export function StoreView(): JSX.Element {
  const regions = useStore((state) => state.regions)
  const settings = useStore((state) => state.settings)
  const entries = useStore((state) => state.entries)
  const featured = useStore((state) => state.featured)
  const games = useStore((state) => state.games)
  const total = useStore((state) => state.total)
  const hasMore = useStore((state) => state.hasMore)
  const query = useStore((state) => state.query)
  const genre = useStore((state) => state.genre)
  const mode = useStore((state) => state.mode)
  const loading = useStore((state) => state.loading)
  const loadingMore = useStore((state) => state.loadingMore)
  const error = useStore((state) => state.error)
  const load = useStore((state) => state.load)
  const fetchPage = useStore((state) => state.fetchPage)
  const setQuery = useStore((state) => state.setQuery)
  const setGenre = useStore((state) => state.setGenre)
  const setMode = useStore((state) => state.setMode)
  const loadMore = useStore((state) => state.loadMore)
  const openGame = useStore((state) => state.openGame)

  const [text, setText] = useState(query)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const loaded = useRef(false)
  const lastQuery = useRef(query)

  useEffect(() => {
    if (loaded.current) return
    loaded.current = true
    void load()
  }, [load])

  // Debounced server-side search.
  useEffect(() => {
    if (!loaded.current) return
    if (text === lastQuery.current) return
    const timer = setTimeout(() => {
      lastQuery.current = text
      setQuery(text)
      void fetchPage(true)
    }, 350)
    return () => clearTimeout(timer)
  }, [text, setQuery, fetchPage])

  const submitSearch = (): void => {
    if (text === lastQuery.current) return
    lastQuery.current = text
    setQuery(text)
    void fetchPage(true)
  }

  const clearSearch = (): void => {
    setText('')
    lastQuery.current = ''
    setQuery('')
    void fetchPage(true)
  }

  const chooseGenre = (key: string): void => {
    if (key === genre) return
    setGenre(key)
    void fetchPage(true)
  }

  const activeRegion = regions.find((entry) => entry.code === settings?.region)

  return (
    <div>
      <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Gamepad2 className="h-5 w-5 text-primary" /> Games
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Browse the PS5 games catalog, build a library, and install from dumps you own.
          </p>
        </div>

        <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto">
          <div className="relative min-w-0 flex-1 lg:w-72 lg:flex-none">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submitSearch()
              }}
              placeholder="Search PS5 games…"
              className="pl-9 pr-9"
              spellCheck={false}
            />
            {text ? (
              <button
                aria-label="Clear search"
                onClick={clearSearch}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>
          <Button variant="outline" aria-label="Catalog settings" onClick={() => setSettingsOpen(true)}>
            <SlidersHorizontal />
            <span className="hidden sm:inline">{activeRegion?.label ?? 'Catalog settings'}</span>
          </Button>
        </div>
      </header>

      <div className="mb-6 flex w-fit items-center gap-1 rounded-xl border border-border/60 bg-secondary/30 p-1">
        <button
          onClick={() => setMode('discover')}
          className={cn(
            'inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
            mode === 'discover'
              ? 'bg-primary/15 text-primary'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Compass className="h-4 w-4" /> Discover
        </button>
        <button
          onClick={() => setMode('library')}
          className={cn(
            'inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
            mode === 'library'
              ? 'bg-primary/15 text-primary'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Library className="h-4 w-4" /> My library
          {entries.length > 0 ? (
            <span className="rounded-full bg-secondary px-1.5 text-[11px] tabular-nums">
              {entries.length}
            </span>
          ) : null}
        </button>
      </div>

      {error ? (
        <div className="mb-5 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
          <WifiOff className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="flex-1 leading-relaxed">{error}</div>
          <button
            aria-label="Retry"
            onClick={() => void fetchPage(true)}
            className="rounded p-1 transition-colors hover:bg-amber-500/20"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      {mode === 'library' ? (
        entries.length === 0 ? (
          <div className="flex min-h-[46vh] flex-col items-center justify-center text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-border/60 bg-card">
              <Library className="h-7 w-7 text-muted-foreground/50" />
            </div>
            <h2 className="text-lg font-semibold">Nothing saved yet</h2>
            <p className="mt-2 max-w-sm text-sm text-muted-foreground">
              Add games from the catalog to keep them here, then attach a dump you own to install
              them.
            </p>
            <Button className="mt-5" onClick={() => setMode('discover')}>
              <Compass /> Browse games
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
            {entries.map((entry, index) => (
              <StoreGameCard key={entry.game.id} game={entry.game} index={index} />
            ))}
          </div>
        )
      ) : (
        <>
          {!query && !genre ? <Featured games={featured} onOpen={openGame} /> : null}

          <div className="mb-5 flex flex-wrap gap-1.5">
            {GENRES.map((chip) => (
              <button
                key={chip.key}
                onClick={() => chooseGenre(chip.key)}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                  genre === chip.key
                    ? 'border-primary/50 bg-primary/15 text-primary'
                    : 'border-border/60 bg-secondary/30 text-muted-foreground hover:border-border hover:text-foreground'
                )}
              >
                {chip.label}
              </button>
            ))}
          </div>

          <div className="mb-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span className="truncate">
              {query
                ? `Results for “${query}”`
                : genre
                  ? GENRES.find((chip) => chip.key === genre)?.label ?? 'Games'
                  : 'New & recent PS5 releases'}
              {total > 0
                ? ` · ${total.toLocaleString()} ${total === 1 ? 'game' : 'games'}`
                : ''}
            </span>
            {loading ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : null}
          </div>

          {loading && games.length === 0 ? (
            <GridSkeleton />
          ) : games.length === 0 ? (
            <div className="flex min-h-[36vh] flex-col items-center justify-center text-center">
              <p className="text-sm font-medium">No games found</p>
              <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                Try another title, or clear the search and genre filters.
              </p>
              <Button
                variant="outline"
                className="mt-4"
                onClick={() => {
                  setText('')
                  lastQuery.current = ''
                  setQuery('')
                  setGenre('')
                  void fetchPage(true)
                }}
              >
                <RefreshCw /> Reset filters
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
              {games.map((game, index) => (
                <StoreGameCard key={game.id} game={game} index={index} />
              ))}
            </div>
          )}

          {hasMore ? (
            <div className="mt-8 flex justify-center">
              <Button variant="outline" onClick={loadMore} disabled={loadingMore || loading}>
                {loadingMore ? <Loader2 className="animate-spin" /> : null}
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          ) : null}
        </>
      )}

      <StoreSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  )
}
