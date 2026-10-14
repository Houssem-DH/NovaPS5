import { Play, Trash2, Gamepad2 } from 'lucide-react'
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
      <div className="relative aspect-[3/4] overflow-hidden rounded-xl border border-border/60 bg-card transition-all duration-300 group-hover:-translate-y-1 group-hover:border-primary/50 group-hover:shadow-2xl group-hover:shadow-primary/10">
        {cover ? (
          <img
            src={cover}
            alt={game.name}
            draggable={false}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="cover-fallback flex h-full w-full items-center justify-center">
            <Gamepad2 className="h-12 w-12 text-muted-foreground/30" />
          </div>
        )}

        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/15 to-transparent" />

        {/* Hover play overlay */}
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 backdrop-blur-[1px] transition-opacity duration-300 group-hover:opacity-100">
          <button
            aria-label={`Play ${game.name}`}
            onClick={(e) => {
              e.stopPropagation()
              launch(game.id)
            }}
            className="gradient-play flex h-16 w-16 items-center justify-center rounded-full shadow-2xl transition-transform duration-200 hover:scale-110"
          >
            <Play className="h-7 w-7 translate-x-[1px] text-white" fill="currentColor" />
          </button>
        </div>

        <div className="absolute inset-x-0 bottom-0 p-3">
          <div className="truncate text-sm font-medium text-white">{game.name}</div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-white/60">
            {game.titleId && <span>{game.titleId}</span>}
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
        className="absolute right-2 top-2 rounded-md bg-black/60 p-1.5 text-white/80 opacity-0 transition-all hover:bg-destructive hover:text-white group-hover:opacity-100"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </motion.div>
  )
}
