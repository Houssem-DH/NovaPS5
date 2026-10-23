import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Activity,
  AlertTriangle,
  Check,
  Cpu,
  Gauge,
  Info,
  Keyboard,
  Layers,
  Loader2,
  Maximize2,
  Monitor,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Trash2
} from 'lucide-react'
import { normalizeGameGraphics } from '@shared/types'
import type {
  DisplayInfo,
  Game,
  GameGraphics,
  GamePerformanceProfile,
  OverlayPosition,
  PresentMode
} from '@shared/types'
import { graphicsBridge, useLibrary } from '@/store/useLibrary'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { formatBytes } from '@/lib/format'
import { SessionMetrics } from './SessionMetrics'

const PRESENT_MODES: Array<{ value: PresentMode; label: string; hint: string }> = [
  {
    value: 'fifo',
    label: 'VSync (FIFO)',
    hint: 'Waits for the display. No tearing; the safest default.'
  },
  {
    value: 'fifo_latest_ready',
    label: 'VSync — latest ready',
    hint: 'Stays synced but skips stale frames. Needs driver support; if the game does not start, use VSync.'
  },
  {
    value: 'mailbox',
    label: 'Mailbox',
    hint: 'Shows the newest frame without waiting. May drop frames; needs driver support.'
  },
  {
    value: 'immediate',
    label: 'Immediate',
    hint: 'Presents at once. Lowest latency, can tear; needs driver support.'
  }
]

const OVERLAY_POSITIONS: Array<{ value: OverlayPosition; label: string }> = [
  { value: 'tl', label: 'Top left' },
  { value: 'tr', label: 'Top right' },
  { value: 'bl', label: 'Bottom left' },
  { value: 'br', label: 'Bottom right' }
]

const OVERLAY_LINES: Array<{ key: string; detail: string }> = [
  { key: 'FPS', detail: 'Average presented frames per second.' },
  { key: 'FRAME', detail: 'Time of the most recent frame, in milliseconds.' },
  { key: 'Graph', detail: 'Frame-time history for the last 120 frames.' },
  { key: 'MIN/AVG/MAX', detail: 'Frame-time range across that history.' },
  { key: 'GPU', detail: 'GPU time per frame — only with GPU timing enabled.' },
  { key: 'DRIVER', detail: 'Driver time per frame — only with driver timing enabled.' },
  { key: 'DRAWS / DISPATCH', detail: 'Draw calls and compute dispatches per frame.' },
  { key: 'SHADERS', detail: 'Pipelines active in the window and compiled in total.' },
  { key: 'VRAM / RAM', detail: 'Video-memory and process memory usage.' },
  { key: 'RES', detail: 'Display resolution / game window resolution.' }
]

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '')
}

function refreshLabel(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return 'unknown refresh'
  return Number.isInteger(hz) ? `${hz} Hz` : `${hz.toFixed(2)} Hz`
}

type LimitTone = 'good' | 'warn' | 'info'

interface LimitAdvice {
  tone: LimitTone
  title: string
  detail: string
}

/**
 * Explain a 60 FPS plateau from the two things that actually gate AnyPS5's
 * 119.88 Hz output path: the host display refresh and the title's own
 * attribute3 flag. Present mode is deliberately not part of the verdict — the
 * runtime paces flips at 59.94/119.88 Hz regardless of FIFO, mailbox or
 * immediate.
 */
function limitAdvice(
  display: DisplayInfo | undefined,
  profile: GamePerformanceProfile | null
): LimitAdvice {
  const refresh = display?.refreshRate ?? 0
  const highFrameRate = profile?.highFrameRate

  if (!display || !Number.isFinite(refresh) || refresh <= 0) {
    return {
      tone: 'info',
      title: 'Display refresh unknown',
      detail:
        'NovaPS5 could not read the display refresh rate. AnyPS5 needs a 120 Hz or faster display before it can use its 119.88 Hz output path.'
    }
  }

  // SDL reports an integer refresh rate, so a 119.88 Hz mode reaches AnyPS5 as
  // 120. Round before comparing or a 119.88 Hz display is wrongly called slow.
  if (Math.round(refresh) < 120) {
    if (highFrameRate === false) {
      return {
        tone: 'warn',
        title: `Two limits: display ${refreshLabel(refresh)} and no 120 Hz flag`,
        detail: `The display is below 120 Hz, and this game does not advertise 120 Hz output either. AnyPS5 stays on its 59.94 Hz clock. Raising the display to 120 Hz or higher is still worth doing, but this particular game will stay capped until its own metadata declares 120 Hz output.`
      }
    }
    return {
      tone: 'warn',
      title:
        highFrameRate === true
          ? `Display limited to ${refreshLabel(refresh)}`
          : `Display is ${refreshLabel(refresh)}`,
      detail:
        highFrameRate === true
          ? `This game advertises 120 Hz output, but the display is below 120 Hz. AnyPS5 only switches to its 119.88 Hz path at 120 Hz or faster, so the runtime stays at 59.94 FPS. Raise the refresh rate in Windows display settings.`
          : `AnyPS5 needs a 120 Hz or faster display for its 119.88 Hz output path. At ${refreshLabel(refresh)} the runtime keeps its 59.94 Hz clock, so no game can present above about 60 FPS. Raise the refresh rate in Windows display settings first.`
    }
  }

  if (highFrameRate === false) {
    return {
      tone: 'warn',
      title: 'This game does not advertise 120 Hz output',
      detail:
        'Its param.json does not set attribute3 bit 0x40, which AnyPS5 requires before a title may request the 119.88 Hz output mode. The runtime therefore paces the game at 59.94 FPS. That is a game-side limit; NovaPS5 cannot safely override it.'
    }
  }

  if (highFrameRate === true) {
    return {
      tone: 'good',
      title: '120 Hz output is available',
      detail:
        'The display and the game both support the 119.88 Hz path. If this game still holds 60 FPS, its own frame cap or quality/performance mode is the limit — check the game’s display settings.'
    }
  }

  return {
    tone: 'info',
    title: '120 Hz support unknown',
    detail:
      profile?.detail ??
      'NovaPS5 could not read this game’s metadata, so it cannot tell whether the 119.88 Hz path is available.'
  }
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  label: string
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex w-fit items-center gap-0.5 rounded-lg border border-border/60 bg-secondary/30 p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
            value === option.value
              ? 'bg-primary/15 text-primary'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function ToolCard({
  icon,
  title,
  children
}: {
  icon: ReactNode
  title: string
  children: ReactNode
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-secondary/20 p-3">
      <div className="flex items-center gap-2 text-xs font-medium text-foreground/90">
        {icon}
        {title}
      </div>
      <div className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{children}</div>
    </div>
  )
}

export function GameGraphicsSettings({ game }: { game: Game }) {
  const setGraphics = useLibrary((state) => state.setGraphics)
  const clearShaderCache = useLibrary((state) => state.clearShaderCache)
  const runtimeVersion = useLibrary((state) => state.appInfo?.runtimeVersion)

  const saved = normalizeGameGraphics(game.graphics)
  const [value, setValue] = useState<GameGraphics>(saved)
  const [saving, setSaving] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)
  const [clearMessage, setClearMessage] = useState<string | null>(null)
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [displayError, setDisplayError] = useState<string | null>(null)
  const [profile, setProfile] = useState<GamePerformanceProfile | null>(null)
  const [profileError, setProfileError] = useState<string | null>(null)

  useEffect(() => {
    // Keep the form in sync if the settings are saved from another panel
    // (for example the catalog dialog stays open over the library detail).
    setValue(normalizeGameGraphics(game.graphics))
  }, [game.id, game.graphics])

  useEffect(() => {
    setError(null)
    setJustSaved(false)
    setClearMessage(null)
  }, [game.id])

  useEffect(() => {
    let cancelled = false
    const loadDisplays = async (): Promise<void> => {
      try {
        const list = await graphicsBridge().displays()
        if (!cancelled) {
          setDisplays(list)
          setDisplayError(null)
        }
      } catch (caught) {
        if (!cancelled) setDisplayError(messageOf(caught))
      }
    }
    void loadDisplays()
    // Windows may switch refresh rate when the game enters fullscreen, so
    // re-read the display list when the user comes back to NovaPS5.
    window.addEventListener('focus', loadDisplays)
    return () => {
      cancelled = true
      window.removeEventListener('focus', loadDisplays)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setProfile(null)
    setProfileError(null)
    const loadProfile = async (): Promise<void> => {
      try {
        const next = await graphicsBridge().performance(game.id)
        if (!cancelled) setProfile(next)
      } catch (caught) {
        if (!cancelled) setProfileError(messageOf(caught))
      }
    }
    void loadProfile()
    return () => {
      cancelled = true
    }
  }, [game.id, game.installedAt])

  const normalized = normalizeGameGraphics(value)
  const dirty = JSON.stringify(normalized) !== JSON.stringify(saved)
  const activeMode = PRESENT_MODES.find((mode) => mode.value === value.presentMode)
  const vsyncOn = value.presentMode === 'fifo' || value.presentMode === 'fifo_latest_ready'
  const primaryDisplay = displays.find((display) => display.primary) ?? displays[0]
  const advice = limitAdvice(primaryDisplay, profile)

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    setJustSaved(false)
    try {
      await setGraphics(game.id, normalized)
      setValue(normalized)
      setJustSaved(true)
      window.setTimeout(() => setJustSaved(false), 2000)
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setSaving(false)
    }
  }

  const clear = async (): Promise<void> => {
    setClearing(true)
    setError(null)
    setClearMessage(null)
    try {
      const result = await clearShaderCache(game.id)
      if (!result.ok) throw new Error(result.error ?? 'Could not clear the shader cache.')
      setClearMessage(
        result.freedBytes
          ? `Cleared ${formatBytes(result.freedBytes)} — rebuilt on the next launch.`
          : 'Shader cache cleared — rebuilt on the next launch.'
      )
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setClearing(false)
    }
  }

  return (
    <section className="panel mt-6 p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Monitor className="h-4 w-4" />
        </div>
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">Graphics &amp; launch</h2>
            {dirty ? (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300">
                Unsaved changes
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Saved for this game and applied by NovaPS5 right before it starts.
          </p>
        </div>
      </div>

      {/* Framerate ---------------------------------------------------------- */}
      <div className="mt-4 rounded-xl border border-border/60 bg-secondary/10 p-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-foreground/90">
          <Gauge className="h-3.5 w-3.5 text-muted-foreground" />
          Framerate &amp; sync
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-foreground/90">VSync</span>
              <Segmented
                label="VSync"
                value={vsyncOn ? 'on' : 'off'}
                options={[
                  { value: 'on', label: 'On' },
                  { value: 'off', label: 'Off' }
                ]}
                onChange={(next) =>
                  setValue((current) => ({
                    ...current,
                    // Keep an advanced mode when it already belongs to the
                    // requested group, instead of silently downgrading
                    // mailbox/latest-ready to immediate/fifo.
                    presentMode:
                      next === 'on'
                        ? current.presentMode === 'fifo' ||
                          current.presentMode === 'fifo_latest_ready'
                          ? current.presentMode
                          : 'fifo'
                        : current.presentMode === 'mailbox' ||
                            current.presentMode === 'immediate'
                          ? current.presentMode
                          : 'immediate'
                  }))
                }
              />
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {vsyncOn
                ? 'On uses FIFO: the presenter waits for the display, so there is no tearing.'
                : 'Off uses immediate: the newest frame is presented at once. Lower latency, but it can tear. If the game fails to start, switch VSync back on.'}
            </p>
            <p className="text-[10px] leading-relaxed text-muted-foreground/80">
              Present mode changes latency and tearing, not the frame-rate ceiling. AnyPS5 still
              paces flips at 59.94 FPS unless the game requests its 119.88 Hz output mode.
            </p>
          </div>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-foreground/90">Present mode (advanced)</span>
            <select
              value={value.presentMode}
              onChange={(event) =>
                setValue((current) => ({
                  ...current,
                  presentMode: event.target.value as PresentMode
                }))
              }
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {PRESENT_MODES.map((mode) => (
                <option key={mode.value} value={mode.value} className="bg-card text-foreground">
                  {mode.label}
                </option>
              ))}
            </select>
            <span className="block text-[11px] leading-relaxed text-muted-foreground">
              {activeMode?.hint}
            </span>
          </label>
        </div>

        <div
          className={cn(
            'mt-3 rounded-lg border p-2.5',
            advice.tone === 'good' && 'border-emerald-500/25 bg-emerald-500/[0.06]',
            advice.tone === 'warn' && 'border-amber-500/25 bg-amber-500/[0.06]',
            advice.tone === 'info' && 'border-sky-500/20 bg-sky-500/[0.06]'
          )}
        >
          <div className="flex items-start gap-2">
            {advice.tone === 'good' ? (
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" />
            ) : advice.tone === 'warn' ? (
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
            ) : (
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-300" />
            )}
            <div className="min-w-0">
              <div className="text-[11px] font-medium text-foreground/90">{advice.title}</div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                {advice.detail}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className="rounded-full bg-background/50 px-2 py-0.5">
                  Display {primaryDisplay ? refreshLabel(primaryDisplay.refreshRate) : 'unknown'}
                </span>
                <span className="rounded-full bg-background/50 px-2 py-0.5">
                  120 Hz flag:{' '}
                  {profile?.highFrameRate === true
                    ? 'advertised'
                    : profile?.highFrameRate === false
                      ? 'not advertised'
                      : 'unknown'}
                </span>
                {profile?.attribute3 !== null && profile?.attribute3 !== undefined ? (
                  <span className="rounded-full bg-background/50 px-2 py-0.5 font-mono">
                    attribute3 0x{profile.attribute3.toString(16)}
                  </span>
                ) : null}
              </div>
              {profile?.detail ? (
                <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground/80">
                  {profile.detail}
                </p>
              ) : null}
              {profileError ? (
                <p className="mt-1 text-[10px] leading-relaxed text-amber-300">{profileError}</p>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {/* Window and display ------------------------------------------------- */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <ToolCard icon={<Maximize2 className="h-3.5 w-3.5 text-muted-foreground" />} title="Borderless fullscreen">
          <div className="flex flex-wrap items-center gap-1.5">
            <span>Toggle it in-game with</span>
            <kbd className="inline-flex items-center gap-1 rounded border border-border/70 bg-background/60 px-1.5 py-0.5 font-mono text-[10px] text-foreground/90">
              <Keyboard className="h-3 w-3" /> F11
            </kbd>
            <span>or a custom binding in</span>
            <span className="font-mono text-[10px] text-foreground/80">anyps5-input.ini</span>
          </div>
          <p className="mt-1.5">
            AnyPS5 uses borderless desktop fullscreen. It has no startup window-mode option, so
            NovaPS5 cannot pre-set fullscreen before the game opens; F11 is the real runtime toggle.
          </p>
        </ToolCard>

        <ToolCard icon={<RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />} title="Display refresh rate">
          {primaryDisplay ? (
            <div className="font-mono text-[11px] text-foreground/85">
              {primaryDisplay.width} × {primaryDisplay.height} ·{' '}
              {refreshLabel(primaryDisplay.refreshRate)}
              <span className="ml-1.5 font-sans text-[10px] text-muted-foreground">primary</span>
            </div>
          ) : displayError ? (
            <span className="text-amber-300">{displayError}</span>
          ) : (
            <span>Reading the host display…</span>
          )}
          {displays.length > 1 ? (
            <div className="mt-1 space-y-0.5">
              {displays
                .filter((display) => display.id !== primaryDisplay?.id)
                .map((display) => (
                  <div key={display.id} className="font-mono text-[10px] text-muted-foreground">
                    {display.label}: {display.width} × {display.height} ·{' '}
                    {refreshLabel(display.refreshRate)}
                  </div>
                ))}
            </div>
          ) : null}
          <p className="mt-1.5">
            Read-only: AnyPS5 follows the desktop display mode and has no refresh-rate override.
            Change it in Windows display settings. 120 Hz or faster lets the runtime use its
            119.88 Hz path, but the game must also advertise 120 Hz output in its metadata; the
            game still chooses its own frame rate.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => void window.api?.openDisplaySettings?.()}
          >
            <RefreshCw /> Open display settings
          </Button>
        </ToolCard>
      </div>

      {/* GPU and quality ---------------------------------------------------- */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5 rounded-xl border border-border/60 bg-secondary/20 p-3">
          <span className="flex items-center gap-2 text-xs font-medium text-foreground/90">
            <Cpu className="h-3.5 w-3.5 text-muted-foreground" /> Vulkan GPU
          </span>
          <Input
            value={value.gpu ?? ''}
            onChange={(event) =>
              setValue((current) => ({ ...current, gpu: event.target.value }))
            }
            placeholder="Automatic — first Vulkan device"
            spellCheck={false}
          />
          <span className="block text-[11px] leading-relaxed text-muted-foreground">
            Leave empty to let AnyPS5 choose. Or enter part of a device name, e.g. RTX 3060.
          </span>
        </label>

        <ToolCard icon={<SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />} title="Graphics quality">
          <p>
            Render resolution, quality presets, FSR, and DLSS are chosen by the game, not by the
            runtime. AnyPS5 has no global quality or render-scale override, so NovaPS5 does not
            expose a fake one. Use the game&apos;s own display or quality menu; these launch controls
            stay active alongside it.
          </p>
          <button
            type="button"
            onClick={() =>
              window.api.openExternal(
                'https://github.com/boykopovar/AnyPS5/blob/main/docs/user/USAGE.md#display-resolution-and-window-size'
              )
            }
            className="mt-1.5 text-[11px] underline underline-offset-2 transition-colors hover:text-foreground"
          >
            Runtime display docs
          </button>
        </ToolCard>
      </div>

      {/* Overlay and metrics ------------------------------------------------- */}
      <div className="mt-4 rounded-xl border border-border/60 bg-secondary/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <Activity className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="text-xs font-medium text-foreground/90">Performance overlay</div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                FPS, frame time, graph, memory, draw calls, and the display/window resolution. F10
                toggles it in-game.
              </div>
            </div>
          </div>
          <Segmented
            label="Performance overlay"
            value={value.overlay ? 'on' : 'off'}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'on', label: 'On' }
            ]}
            onChange={(next) =>
              setValue((current) => ({ ...current, overlay: next === 'on' }))
            }
          />
        </div>

        {value.overlay ? (
          <>
            <div className="mt-2 flex flex-wrap items-center gap-2 pl-1">
              <span className="text-[11px] text-muted-foreground">Overlay position</span>
              <Segmented
                label="Overlay position"
                value={value.overlayPosition}
                options={OVERLAY_POSITIONS}
                onChange={(next) =>
                  setValue((current) => ({ ...current, overlayPosition: next }))
                }
              />
            </div>

            <div className="mt-3 grid gap-x-4 gap-y-1 rounded-lg border border-border/50 bg-background/30 p-2.5 sm:grid-cols-2">
              {OVERLAY_LINES.map((line) => (
                <div key={line.key} className="flex gap-2 text-[10px] leading-relaxed">
                  <span className="w-[86px] shrink-0 font-mono text-foreground/80">{line.key}</span>
                  <span className="text-muted-foreground">{line.detail}</span>
                </div>
              ))}
            </div>
          </>
        ) : null}

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-background/30 px-2.5 py-2">
            <div className="min-w-0">
              <div className="text-[11px] font-medium text-foreground/90">GPU timing</div>
              <div className="text-[10px] leading-relaxed text-muted-foreground">
                Adds a GPU line to the overlay.
              </div>
            </div>
            <Segmented
              label="GPU timing"
              value={value.gpuProfile ? 'on' : 'off'}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'on', label: 'On' }
              ]}
              onChange={(next) =>
                setValue((current) => ({ ...current, gpuProfile: next === 'on' }))
              }
            />
          </div>
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-background/30 px-2.5 py-2">
            <div className="min-w-0">
              <div className="text-[11px] font-medium text-foreground/90">Driver timing</div>
              <div className="text-[10px] leading-relaxed text-muted-foreground">
                Adds a DRIVER line and extra detail.
              </div>
            </div>
            <Segmented
              label="Driver timing"
              value={value.drawProfile ? 'on' : 'off'}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'on', label: 'On' }
              ]}
              onChange={(next) =>
                setValue((current) => ({ ...current, drawProfile: next === 'on' }))
              }
            />
          </div>
        </div>

        {value.gpuProfile || value.drawProfile ? (
          <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-amber-300/90">
            <Info className="mt-0.5 h-3 w-3 shrink-0" />
            Profiling adds overhead. The overlay shows PROFILED and its FPS/frame numbers are not
            comparable with a normal run — turn these off after measuring.
          </p>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/50 bg-background/30 px-2.5 py-2">
          <div className="min-w-0">
            <div className="text-[11px] font-medium text-foreground/90">Session monitoring</div>
            <div className="text-[10px] leading-relaxed text-muted-foreground">
              Record FPS samples to a per-launch telemetry file for the live monitor below.
            </div>
          </div>
          <Segmented
            label="Session monitoring"
            value={value.telemetry ? 'on' : 'off'}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'on', label: 'On' }
            ]}
            onChange={(next) =>
              setValue((current) => ({ ...current, telemetry: next === 'on' }))
            }
          />
        </div>

        <SessionMetrics
          game={game}
          telemetryEnabled={value.telemetry}
          profile={profile}
          display={primaryDisplay}
        />
      </div>

      {/* Shader cache ------------------------------------------------------- */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-secondary/20 p-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <Layers className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="text-xs font-medium text-foreground/90">Shader cache</div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
              Keeps recompiled shaders and pipelines so later launches start faster.
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={clear}
            disabled={clearing}
            title="Delete this game's shader and pipeline cache"
          >
            {clearing ? <Loader2 className="animate-spin" /> : <Trash2 />} Clear
          </Button>
          <Segmented
            label="Shader cache"
            value={value.shaderCache ? 'on' : 'off'}
            options={[
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' }
            ]}
            onChange={(next) =>
              setValue((current) => ({ ...current, shaderCache: next === 'on' }))
            }
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={save} disabled={!dirty || saving}>
          {saving ? (
            <Loader2 className="animate-spin" />
          ) : justSaved ? (
            <Check />
          ) : null}
          {saving ? 'Saving…' : justSaved ? 'Saved' : 'Save changes'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setValue(normalizeGameGraphics())}
          disabled={!dirty || saving}
        >
          <RotateCcw /> Reset to defaults
        </Button>
      </div>

      {error ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-red-300">
          <span className="min-w-0 flex-1">{error}</span>
          {error.toLowerCase().includes('preload') ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => window.location.reload()}
            >
              Reload window
            </Button>
          ) : null}
        </div>
      ) : null}
      {clearMessage ? (
        <p className="mt-3 text-[11px] text-emerald-300" role="status">
          {clearMessage}
        </p>
      ) : null}

      <div className="mt-4 flex items-start gap-2 rounded-xl border border-sky-500/20 bg-sky-500/[0.06] p-3 text-[11px] leading-relaxed text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-300" />
        <span>
          <span className="font-medium text-foreground/90">
            FSR, DLSS, and resolution are game-side.
          </span>{' '}
          {runtimeVersion ? `AnyPS5 ${runtimeVersion}` : 'AnyPS5'} renders at the resolution the
          game chooses and has no upscaler override, so NovaPS5 cannot add FSR or DLSS to a game
          that does not support them. If the game has a display or quality menu, set them there;
          these launch controls stay active alongside it.{' '}
          <button
            type="button"
            onClick={() =>
              window.api.openExternal(
                'https://github.com/boykopovar/AnyPS5/blob/main/docs/user/USAGE.md#display-resolution-and-window-size'
              )
            }
            className="underline underline-offset-2 transition-colors hover:text-foreground"
          >
            Runtime display docs
          </button>
        </span>
      </div>
    </section>
  )
}
