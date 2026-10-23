import { useEffect, useId, useState } from 'react'
import { Activity, AlertTriangle, Gauge, Info, Loader2, Play, Timer } from 'lucide-react'
import type {
  DisplayInfo,
  Game,
  GamePerformanceProfile,
  GameSession
} from '@shared/types'
import { graphicsBridge } from '@/store/useLibrary'
import { cn } from '@/lib/utils'

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '')
}

function showRate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—'
  return value >= 10 ? value.toFixed(1) : value.toFixed(2)
}

function showMs(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—'
  return `${value.toFixed(1)} ms`
}

interface FpsStats {
  latest: number
  average: number
  minimum: number
  maximum: number
  onePercentLow: number
  frameMs: number
}

function fpsStats(session: GameSession | null): FpsStats | null {
  if (!session || session.samples.length === 0) return null
  const values = session.samples.map((sample) => sample.fps).filter((fps) => fps > 0)
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const worstCount = Math.max(1, Math.ceil(sorted.length * 0.01))
  const worst = sorted.slice(0, worstCount)
  const latest = values[values.length - 1]
  return {
    latest,
    average: values.reduce((sum, fps) => sum + fps, 0) / values.length,
    minimum: sorted[0],
    maximum: sorted[sorted.length - 1],
    onePercentLow: worst.reduce((sum, fps) => sum + fps, 0) / worst.length,
    frameMs: latest > 0 ? 1000 / latest : 0
  }
}

function refreshLabel(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return 'unknown refresh'
  return Number.isInteger(hz) ? `${hz} Hz` : `${hz.toFixed(2)} Hz`
}

type VerdictTone = 'good' | 'warn' | 'info'

interface FramerateVerdict {
  label: string
  detail: string
  tone: VerdictTone
}

/**
 * Turn a stable plateau in the sampled average into a plain-language reason.
 * The runtime can only pace presents at 59.94 or 119.88 Hz, so those two
 * averages have specific causes worth spelling out.
 */
function framerateVerdict(
  stats: FpsStats | null,
  display: DisplayInfo | undefined,
  profile: GamePerformanceProfile | null
): FramerateVerdict | null {
  if (!stats) return null
  const average = stats.average
  const refresh = display?.refreshRate ?? 0
  const belowHighFrameRate = refresh > 0 && Math.round(refresh) < 120
  const near = (target: number, tolerance: number): boolean =>
    Math.abs(average - target) <= tolerance

  if (near(59.94, 1.6)) {
    if (belowHighFrameRate && profile?.highFrameRate === false) {
      return {
        tone: 'warn',
        label: '≈60 FPS — display and game limits',
        detail: `The display runs at ${refreshLabel(refresh)} and this game does not advertise 120 Hz output, so AnyPS5 stays on its 59.94 Hz clock. Raising the display alone will not unlock this game.`
      }
    }
    if (belowHighFrameRate) {
      return {
        tone: 'warn',
        label: '≈60 FPS — display limited',
        detail: `The display runs at ${refreshLabel(refresh)}. Raise it to 120 Hz or higher in Windows display settings; until then AnyPS5 keeps its 59.94 Hz clock.`
      }
    }
    if (profile?.highFrameRate === false) {
      return {
        tone: 'warn',
        label: '≈60 FPS — game-side cap',
        detail:
          'This game does not advertise 120 Hz output, so AnyPS5 runs it on the 59.94 Hz clock. That limit is in the game metadata, not a missing NovaPS5 setting.'
      }
    }
    if (profile?.highFrameRate === true) {
      return {
        tone: 'info',
        label: '≈60 FPS — in-game limit',
        detail:
          'The 120 Hz output path is available, so the game itself is holding 60 FPS. Check its quality/performance mode or internal frame cap.'
      }
    }
    return {
      tone: 'info',
      label: '≈60 FPS',
      detail:
        'Check the display refresh rate and the game’s own frame cap. AnyPS5 cannot exceed 59.94 FPS without the title’s 119.88 Hz output mode.'
    }
  }

  if (near(29.97, 1.5)) {
    return {
      tone: 'info',
      label: '≈30 FPS',
      detail:
        'About 30 FPS is normally the game’s quality mode or an internal cap; check its display/performance settings.'
    }
  }

  if (near(119.88, 2.2)) {
    return {
      tone: 'good',
      label: '≈120 FPS',
      detail: 'This run is using AnyPS5’s 119.88 Hz output path.'
    }
  }

  return null
}

function Sparkline({ session }: { session: GameSession }) {
  const gradientId = useId().replace(/:/g, '')
  const fps = session.samples.map((sample) => sample.fps)
  if (fps.length < 2) {
    return (
      <div className="flex h-[72px] items-center justify-center rounded-lg border border-border/50 bg-background/40 text-[11px] text-muted-foreground">
        Waiting for the first present samples…
      </div>
    )
  }

  const width = 320
  const height = 72
  const padding = 3
  const ceiling = Math.max(60, ...fps) * 1.08
  const guide = ceiling > 62 ? 60 : null
  const guideY =
    guide === null
      ? null
      : height - padding - (guide / ceiling) * (height - padding * 2)
  const step = (width - padding * 2) / (fps.length - 1)
  const point = (value: number, index: number): string => {
    const x = padding + index * step
    const y = height - padding - (Math.min(value, ceiling) / ceiling) * (height - padding * 2)
    return `${x.toFixed(2)},${y.toFixed(2)}`
  }
  const points = fps.map(point).join(' ')
  const area = `${padding},${height - padding} ${points} ${width - padding},${height - padding}`

  return (
    <div className="rounded-lg border border-border/50 bg-background/40 p-2">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-[72px] w-full text-emerald-400"
        role="img"
        aria-label="Frames per second over the last telemetry samples"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        {guideY !== null ? (
          <line
            x1={padding}
            y1={guideY}
            x2={width - padding}
            y2={guideY}
            stroke="currentColor"
            strokeOpacity="0.18"
            strokeDasharray="3 4"
          />
        ) : null}
        <polygon points={area} fill={`url(#${gradientId})`} />
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      {guide !== null ? (
        <div className="mt-1 text-right text-[9px] leading-none text-muted-foreground/70">
          dashed line: 60 FPS
        </div>
      ) : null}
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-border/50 bg-secondary/20 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
      <div
        className={cn(
          'mt-0.5 font-mono text-sm font-semibold tabular-nums',
          accent ? 'text-emerald-300' : 'text-foreground/90'
        )}
      >
        {value}
      </div>
    </div>
  )
}

/**
 * Live view of the videoout telemetry AnyPS5 writes when
 * APS5_VIDEOOUT_TELEMETRY_DIR is set. Samples arrive every 30 presents, so the
 * chart is a trend line, not a full frame trace.
 */
export function SessionMetrics({
  game,
  telemetryEnabled,
  profile,
  display
}: {
  game: Game
  telemetryEnabled: boolean
  profile: GamePerformanceProfile | null
  display: DisplayInfo | undefined
}) {
  const [session, setSession] = useState<GameSession | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    const poll = async (): Promise<void> => {
      try {
        const next = await graphicsBridge().session(game.id)
        if (!cancelled) {
          setSession(next)
          setError(null)
        }
      } catch (caught) {
        if (!cancelled) setError(messageOf(caught))
      }
    }

    void poll()
    timer = window.setInterval(() => void poll(), 1000)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [game.id])

  const stats = fpsStats(session)
  const verdict = framerateVerdict(stats, display, profile)
  const hasSamples = (session?.samples.length ?? 0) > 0
  const live = session?.active === true

  return (
    <div className="mt-2 rounded-xl border border-border/60 bg-secondary/10 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <div>
            <div className="text-xs font-medium text-foreground/90">Session monitor</div>
            <div className="text-[11px] text-muted-foreground">
              Live FPS sampled from AnyPS5 videoout telemetry.
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!telemetryEnabled ? (
            <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              Monitoring off
            </span>
          ) : live ? (
            <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              Live
            </span>
          ) : hasSamples ? (
            <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              Last session
            </span>
          ) : (
            <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              Waiting
            </span>
          )}
        </div>
      </div>

      {!telemetryEnabled ? (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-border/50 bg-background/40 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
          <Gauge className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Session monitoring is turned off for this game. Enable it above, save, then launch the
            game to collect FPS samples.
          </span>
        </div>
      ) : error ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-red-300">
          <span className="min-w-0 flex-1">{error}</span>
          {error.toLowerCase().includes('preload') ? (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-md border border-border/60 px-2 py-1 text-[11px] hover:text-foreground"
            >
              Reload window
            </button>
          ) : null}
        </div>
      ) : live && !hasSamples ? (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-border/50 bg-background/40 px-3 py-2.5 text-[11px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Game is running — waiting for the first telemetry present line.
        </div>
      ) : session && hasSamples ? (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="FPS" value={showRate(stats?.latest ?? 0)} accent />
            <Stat label="Frame" value={showMs(stats?.frameMs ?? 0)} />
            <Stat label="Average" value={showRate(stats?.average ?? 0)} />
            <Stat label="1% low" value={showRate(stats?.onePercentLow ?? 0)} />
          </div>
          {verdict ? (
            <div
              className={cn(
                'mt-2 flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[11px] leading-relaxed',
                verdict.tone === 'good' && 'border-emerald-500/25 bg-emerald-500/[0.06]',
                verdict.tone === 'warn' && 'border-amber-500/25 bg-amber-500/[0.06]',
                verdict.tone === 'info' && 'border-sky-500/20 bg-sky-500/[0.06]'
              )}
            >
              {verdict.tone === 'warn' ? (
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
              ) : verdict.tone === 'good' ? (
                <Activity className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" />
              ) : (
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-300" />
              )}
              <div className="min-w-0">
                <span className="font-medium text-foreground/90">{verdict.label}</span>{' '}
                <span className="text-muted-foreground">{verdict.detail}</span>
              </div>
            </div>
          ) : null}
          <div className="mt-2">
            <Sparkline session={session} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
            <span>
              Min <span className="font-mono text-foreground/80">{showRate(stats?.minimum ?? 0)}</span>
            </span>
            <span>
              Max <span className="font-mono text-foreground/80">{showRate(stats?.maximum ?? 0)}</span>
            </span>
            <span className="flex items-center gap-1">
              <Timer className="h-3 w-3" />
              {session.samples.length} samples
            </span>
            {session.dropped > 0 ? (
              <span className="flex items-center gap-1 text-amber-300">
                <AlertTriangle className="h-3 w-3" />
                {session.dropped} telemetry drops
              </span>
            ) : null}
            <span>one sample every 30 presents</span>
          </div>
        </>
      ) : session?.startedAt && !session.telemetry ? (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-border/50 bg-background/40 px-3 py-2.5 text-[11px] text-muted-foreground">
          <Gauge className="h-3.5 w-3.5" />
          The last run was launched with monitoring off. Enable it above and launch again to collect
          samples.
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-border/50 bg-background/40 px-3 py-2.5 text-[11px] text-muted-foreground">
          <Play className="h-3.5 w-3.5" />
          Launch this game to start collecting session metrics.
        </div>
      )}

      <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
        Samples come from the runtime&apos;s local <span className="font-mono">videoout.jsonl</span>;
        NovaPS5 reads only the FPS lines. The 1% low is the average of the slowest 1% of samples,
        useful for spotting stutter. A flat ≈60 line is AnyPS5&apos;s 59.94 Hz flip clock unless the
        game requests its 119.88 Hz output mode. The monitor keeps the last run visible after the
        game exits.
      </p>
    </div>
  )
}
