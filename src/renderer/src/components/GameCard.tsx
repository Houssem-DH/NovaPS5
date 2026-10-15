import { Play, Trash2, Gamepad2, AlertTriangle } from 'lucide-react'
import { motion } from 'framer-motion'
import type { Game } from '@shared/types'
import { useLibrary } from '@/store/useLibrary'
import { formatBytes } from '@/lib/format'

export function GameCard({ game, index }: { game: Game; index: number }) {
  const { select, launch, remove } = useLibrary()
  const cover = window.api.coverUrl(game)

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: Math.min(index * 0.03, 0.3) }}
      className="group relative cursor-pointer"
      onClick={() => select(game.id)}
    >
      <div className="relative aspect-[3/4] overflow-hidden rounded-2xl border border-border/60 bg-card transition-all duration-300 group-hover:-translate-y-1 group-hover:border-primary/50 group-hover:shadow-2xl group-hover:shadow-primary/15">
        {cover ? (
          <img
            src={cover}
            alt={game.name}
            draggable={false}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.06]"
          />
        ) : (
          <div className="cover-fallback flex h-full w-full items-center justify-center">
            <Gamepad2 className="h-12 w-12 text-muted-foreground/30" />
          </div>
        )}

        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent" />

        {/* Launch test / integrity verdict */}
        {game.status === 'error' ? (
          <span
            className="absolute left-2 top-2 z-10 inline-flex items-center gap-1 rounded-lg bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200 ring-1 ring-amber-400/40 backdrop-blur-sm"
            title={game.error}
          >
            <AlertTriangle className="h-3 w-3" /> Missing
          </span>
        ) : (
          game.launchState && (
            <span
              className={`absolute left-2 top-2 z-10 inline-flex items-center rounded-lg px-1.5 py-0.5 text-[10px] font-semibold backdrop-blur-sm ring-1 ${
                game.launchState === 'works'
                  ? 'bg-emerald-500/20 text-emerald-200 ring-emerald-400/40'
                  : 'bg-red-500/20 text-red-200 ring-red-400/40'
              }`}
              title={game.launchDetail}
            >
              {game.launchState === 'works' ? '✓ Works' : '✗ Not working'}
            </span>
          )
        )}

        {/* Hover play overlay */}
        <div className="absolute inset-0 flex items-center justify-center bg-black/35 opacity-0 backdrop-blur-[1px] transition-opacity duration-300 group-hover:opacity-100">
          <button
            aria-label={`Play ${game.name}`}
            onClick={(e) => {
              e.stopPropagation()
              launch(game.id)
            }}
            className="gradient-play flex h-16 w-16 items-center justify-center rounded-full shadow-2xl shadow-black/40 transition-transform duration-200 hover:scale-110"
          >
            <Play className="h-7 w-7 translate-x-[1px] text-white" fill="currentColor" />
          </button>
        </div>

        <div className="absolute inset-x-0 bottom-0 p-3.5">
          <div className="truncate text-sm font-semibold text-white">{game.name}</div>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-white/60">
            {game.titleId && <span className="tabular-nums">{game.titleId}</span>}
            <span className="h-1 w-1 rounded-full bg-white/25" />
            <span>{formatBytes(game.sizeBytes)}</span>
          </div>
        </div>
      </div>

      <button
        aria-label="Remove game"
        onClick={(e) => {
          e.stopPropagation()
          remove(game.id)
        }}
        className="absolute right-2 top-2 rounded-lg bg-black/60 p-1.5 text-white/80 opacity-0 backdrop-blur-sm transition-all hover:bg-destructive hover:text-white group-hover:opacity-100"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </motion.div>
  )
}
