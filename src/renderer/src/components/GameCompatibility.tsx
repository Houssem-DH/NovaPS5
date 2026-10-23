import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Loader2, ShieldAlert, Trophy } from 'lucide-react'
import { normalizeGameCompatibility } from '@shared/types'
import type { Game, TrophyDataMode, TrophyPackageInfo } from '@shared/types'
import { graphicsBridge, useLibrary } from '@/store/useLibrary'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatBytes } from '@/lib/format'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * True when the stored launch verdict is the runtime abort on a trophy id its
 * package does not define. The installer now retries automatically, but games
 * installed before that retry existed keep the old verdict.
 */
function mentionsTrophyAbort(detail?: string): boolean {
  return !!detail && /trophy\s+\d+.*(does not define|is not in)/i.test(detail)
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  label: string
  disabled?: boolean
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        'flex w-fit items-center gap-0.5 rounded-lg border border-border/60 bg-secondary/30 p-0.5',
        disabled && 'opacity-60'
      )}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed',
            value === option.value
              ? 'bg-primary/15 text-primary'
              : 'text-muted-foreground enabled:hover:text-foreground'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function GameCompatibilitySettings({ game }: { game: Game }) {
  const setCompatibility = useLibrary((state) => state.setCompatibility)
  const mode = normalizeGameCompatibility(game.compatibility).trophyData

  const [info, setInfo] = useState<TrophyPackageInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    graphicsBridge()
      .trophyPackage(game.id)
      .then((next) => {
        if (!cancelled) setInfo(next)
      })
      .catch((caught) => {
        if (!cancelled) setError(messageOf(caught))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [game.id, game.installedAt])

  const choose = async (next: TrophyDataMode): Promise<void> => {
    if (next === mode || busy) return
    setBusy(true)
    setError(null)
    try {
      await setCompatibility(game.id, { trophyData: next })
      setInfo(await graphicsBridge().trophyPackage(game.id))
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setBusy(false)
    }
  }

  const abortHint = mentionsTrophyAbort(game.launchDetail)
  const files = info?.files ?? []

  return (
    <section className="panel mt-6 p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <ShieldAlert className="h-4 w-4" />
        </div>
        <div>
          <h2 className="text-sm font-semibold">Compatibility</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Workarounds for runtime behaviour that stops this game before it reaches its menu.
          </p>
        </div>
      </div>

      {abortHint && (
        <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] p-3 text-xs text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="space-y-2">
            <p>
              The launch test hit a trophy lookup the game's own trophy package does not define.
              AnyPS5 0.1.3 throws instead of returning the invalid-id error, so the game aborts
              immediately after it starts.
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || mode === 'placeholders'}
              onClick={() => void choose('placeholders')}
            >
              <Trophy className="h-3.5 w-3.5" />
              Use placeholder trophy data
            </Button>
          </div>
        </div>
      )}

      <div className="mt-4 rounded-xl border border-border/60 bg-secondary/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground/90">
            <Trophy className="h-3.5 w-3.5 text-muted-foreground" />
            Trophy data
          </div>
          <Segmented
            label="Trophy data"
            value={mode}
            disabled={busy}
            options={[
              { value: 'package', label: "Game's package" },
              { value: 'placeholders', label: 'Compatibility placeholders' }
            ]}
            onChange={(next) => void choose(next)}
          />
        </div>

        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {mode === 'package'
            ? "The game's own trophy2 package is used, so trophy names, descriptions and the platinum rule come from the game."
            : 'The trophy package is hidden (renamed, not deleted). AnyPS5 then answers every trophy request with placeholder data, so titles that probe past the last trophy id keep running; trophy names, descriptions and platinum rules are unavailable until you switch back.'}
        </p>

        <div className="mt-3 rounded-lg border border-border/50 bg-background/40 p-2.5">
          {loading ? (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Reading the trophy package…
            </div>
          ) : files.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              This install has no trophy2 package. AnyPS5 already uses placeholder trophy data.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {files.map((file) => (
                <li
                  key={file.file}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px]"
                >
                  <span className="flex items-center gap-1.5 font-mono text-foreground/85">
                    {file.disabled ? (
                      <ShieldAlert className="h-3 w-3 text-amber-300" />
                    ) : (
                      <Check className="h-3 w-3 text-emerald-400" />
                    )}
                    {file.file}
                  </span>
                  <span className="text-muted-foreground">
                    {file.disabled ? 'hidden — placeholders in use' : 'read by AnyPS5'}
                    {file.trophyCount !== null && (
                      <>
                        {' · '}
                        {file.trophyCount} {file.trophyCount === 1 ? 'trophy' : 'trophies'}
                        {file.idRange ? ` (${file.idRange[0]}–${file.idRange[1]})` : ''}
                      </>
                    )}
                    {' · '}
                    {formatBytes(file.sizeBytes)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {info?.error && <p className="mt-2 text-[11px] text-amber-300">{info.error}</p>}
        {error && <p className="mt-2 text-[11px] text-amber-300">{error}</p>}
      </div>
    </section>
  )
}
