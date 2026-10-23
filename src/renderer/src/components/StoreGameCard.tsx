import { Check, Download, Gamepad2, Plus } from 'lucide-react'
import { motion } from 'framer-motion'
import type { StoreGame } from '@shared/types'
import { useStore } from '@/store/useStore'
import { useLibrary } from '@/store/useLibrary'
import { cn } from '@/lib/utils'

export function StoreGameCard({ game, index }: { game: StoreGame; index: number }) {
  const entries = useStore((state) => state.entries)
  const addToLibrary = useStore((state) => state.addToLibrary)
  const openGame = useStore((state) => state.openGame)
  const active = useStore((state) => state.progress[game.id])
  const installedGames = useLibrary((state) => state.games)

  const entry = entries.find((candidate) => candidate.game.id === game.id)
  const installedGame =
    (entry?.installedGameId
      ? installedGames.find((candidate) => candidate.id === entry.installedGameId)
      : undefined) ??
    (game.titleId
      ? installedGames.find((candidate) => candidate.titleId === game.titleId)
      : undefined)
  const installed = Boolean(installedGame)
  const downloading = active?.status === 'running'
  const downloadable = Boolean(game.downloadUrl)

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: Math.min(index * 0.02, 0.25) }}
      className="group relative cursor-pointer"
      onClick={() => openGame(game)}
    >
      <div className="relative aspect-[3/4] overflow-hidden rounded-2xl border border-border/60 bg-card transition-all duration-300 group-hover:-translate-y-1 group-hover:border-primary/50 group-hover:shadow-2xl group-hover:shadow-primary/15">
        {game.coverUrl ? (
          <img
            src={game.coverUrl}
            alt={game.name}
            loading="lazy"
            draggable={false}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.06]"
          />
        ) : (
          <div className="cover-fallback flex h-full w-full items-center justify-center">
            <Gamepad2 className="h-12 w-12 text-muted-foreground/30" />
          </div>
        )}

        <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/25 to-transparent" />

        <span className="absolute left-2 top-2 z-10 rounded-lg bg-black/55 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-white/90 ring-1 ring-white/15 backdrop-blur-sm">
          PS5
        </span>

        {installed ? (
          <span className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-lg bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-200 ring-1 ring-emerald-400/40 backdrop-blur-sm">
            <Check className="h-3 w-3" /> Installed
          </span>
        ) : entry ? (
          <span className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-lg bg-primary/20 px-1.5 py-0.5 text-[10px] font-semibold text-primary ring-1 ring-primary/40 backdrop-blur-sm">
            <Check className="h-3 w-3" /> In library
          </span>
        ) : downloadable ? (
          <span className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-lg bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-sky-200 ring-1 ring-sky-400/40 backdrop-blur-sm">
            <Download className="h-3 w-3" /> Download
          </span>
        ) : null}

        <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/35 opacity-0 backdrop-blur-[1px] transition-opacity duration-300 group-hover:opacity-100 group-focus-within:opacity-100">
          <button
            onClick={(event) => {
              event.stopPropagation()
              openGame(game)
            }}
            className="rounded-full bg-white/90 px-4 py-2 text-xs font-semibold text-black shadow-xl transition-transform hover:scale-105"
          >
            Details
          </button>
          <button
            aria-label={entry ? 'In your library' : `Add ${game.name} to your library`}
            disabled={Boolean(entry)}
            onClick={(event) => {
              event.stopPropagation()
              if (!entry) {
                void addToLibrary(game).catch((error) => {
                  console.error('Failed to add game to the catalog library', error)
                })
              }
            }}
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-full shadow-xl transition-transform',
              entry
                ? 'bg-emerald-500/90 text-white'
                : 'gradient-play text-white hover:scale-110'
            )}
          >
            {entry ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          </button>
        </div>

        {downloading && (
          <span className="absolute left-2 top-9 z-10 inline-flex items-center gap-1 rounded-lg bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white ring-1 ring-white/15 backdrop-blur-sm">
            {Math.round(active.percent)}% · {active.step}
          </span>
        )}

        <div className="absolute inset-x-0 bottom-0 p-3.5">
          <div className="truncate text-sm font-semibold text-white">{game.name}</div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-white/60">
            <span className="truncate">{game.publisher ?? 'PS5'}</span>
          </div>
        </div>

        {downloading && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${Math.max(2, Math.min(100, active.percent))}%` }}
            />
          </div>
        )}
      </div>
    </motion.div>
  )
}
