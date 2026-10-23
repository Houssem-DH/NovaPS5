import { Download, Gamepad2, Loader2, Trash2 } from 'lucide-react'
import { motion } from 'framer-motion'
import type { StoreEntry } from '@shared/types'
import { useStore } from '@/store/useStore'
import { formatBytes } from '@/lib/format'

/**
 * A game that lives in the catalog library but has not been installed yet.
 * Rendered inside the main library grid next to installed games, clearly
 * marked "Not installed" and opening the game dialog to install it.
 */
export function WishlistGameCard({ entry, index }: { entry: StoreEntry; index: number }) {
  const openGame = useStore((state) => state.openGame)
  const removeFromLibrary = useStore((state) => state.removeFromLibrary)
  const progress = useStore((state) => state.progress[entry.game.id])

  const game = entry.game
  const running = progress?.status === 'running'
  const percent = Math.max(2, Math.min(100, progress?.percent ?? 0))

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: Math.min(index * 0.03, 0.3) }}
      className="group relative cursor-pointer"
      onClick={() => openGame(game)}
    >
      <div className="relative aspect-[3/4] overflow-hidden rounded-2xl border border-border/50 bg-card transition-all duration-300 group-hover:-translate-y-1 group-hover:border-primary/50 group-hover:shadow-2xl group-hover:shadow-primary/15">
        {game.coverUrl ? (
          <img
            src={game.coverUrl}
            alt={game.name}
            loading="lazy"
            draggable={false}
            className="h-full w-full object-cover opacity-90 saturate-[0.85] transition-transform duration-500 group-hover:scale-[1.06] group-hover:opacity-100 group-hover:saturate-100"
          />
        ) : (
          <div className="cover-fallback flex h-full w-full items-center justify-center">
            <Gamepad2 className="h-12 w-12 text-muted-foreground/30" />
          </div>
        )}

        <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/25 to-transparent" />

        {/* Not installed verdict */}
        <span className="absolute left-2 top-2 z-10 inline-flex items-center gap-1 rounded-lg bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-100 ring-1 ring-amber-400/40 backdrop-blur-sm">
          <Download className="h-3 w-3" /> Not installed
        </span>

        {running ? (
          <span className="absolute left-2 top-8 z-10 inline-flex items-center gap-1 rounded-lg bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white ring-1 ring-white/15 backdrop-blur-sm">
            <Loader2 className="h-3 w-3 animate-spin" />
            {Math.round(progress.percent)}%
          </span>
        ) : null}

        {/* Hover install overlay */}
        <div className="absolute inset-0 flex items-center justify-center bg-black/35 opacity-0 backdrop-blur-[1px] transition-opacity duration-300 group-hover:opacity-100 group-focus-within:opacity-100">
          <button
            aria-label={`Install ${game.name}`}
            onClick={(event) => {
              event.stopPropagation()
              openGame(game)
            }}
            className="gradient-play inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs font-semibold text-white shadow-2xl shadow-black/40 transition-transform duration-200 hover:scale-105"
          >
            <Download className="h-4 w-4" /> Install
          </button>
        </div>

        <div className="absolute inset-x-0 bottom-0 p-3.5">
          <div className="truncate text-sm font-semibold text-white">{game.name}</div>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-white/60">
            <span className="truncate">{game.publisher ?? 'PS5'}</span>
            {game.sizeBytes ? (
              <>
                <span className="h-1 w-1 shrink-0 rounded-full bg-white/25" />
                <span className="shrink-0">{formatBytes(game.sizeBytes)}</span>
              </>
            ) : null}
          </div>
        </div>

        {running ? (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${percent}%` }}
            />
          </div>
        ) : null}
      </div>

      <button
        aria-label={`Remove ${game.name} from your library`}
        onClick={(event) => {
          event.stopPropagation()
          void removeFromLibrary(game.id).catch((error) => {
            console.error('Failed to remove game from the catalog library', error)
          })
        }}
        className="absolute right-2 top-9 rounded-lg bg-black/60 p-1.5 text-white/80 opacity-0 backdrop-blur-sm transition-all hover:bg-destructive hover:text-white group-hover:opacity-100"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </motion.div>
  )
}
