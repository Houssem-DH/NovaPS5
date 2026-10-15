import { useEffect, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Download,
  Loader2,
  PackageOpen,
  RefreshCw,
  Rocket,
  SearchCheck,
  Wrench
} from 'lucide-react'
import type { BootstrapResult, BootstrapStep, BootstrapStepId } from '@shared/types'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const STEP_META: Record<BootstrapStepId, { label: string; icon: LucideIcon }> = {
  check: { label: 'Checking for runtime updates', icon: SearchCheck },
  download: { label: 'Downloading runtime', icon: Download },
  extract: { label: 'Extracting files', icon: PackageOpen },
  install: { label: 'Installing runtime', icon: Wrench },
  ready: { label: 'Ready', icon: Rocket }
}

function StepRow({ step }: { step: BootstrapStep }) {
  const meta = STEP_META[step.id]
  const Icon = meta.icon
  const isActive = step.status === 'active'
  const isDone = step.status === 'done'
  const isError = step.status === 'error'
  const isWarn = step.status === 'warn'

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/50 bg-card/60 px-4 py-3">
      <div
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
          isError ? 'bg-red-500/15 text-red-400' : isWarn ? 'bg-amber-500/15 text-amber-400' : 'bg-primary/15'
        )}
      >
        {isActive ? (
          <Loader2 className={cn('h-4 w-4 animate-spin', 'text-primary')} />
        ) : isError ? (
          <AlertTriangle className="h-4 w-4" />
        ) : isDone ? (
          <CheckCircle2 className="h-4 w-4 text-primary" />
        ) : isWarn ? (
          <AlertTriangle className="h-4 w-4" />
        ) : (
          <Icon className="h-4 w-4 text-muted-foreground" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-medium text-foreground/90">{step.label || meta.label}</span>
          {isActive && typeof step.percent === 'number' && step.id === 'download' && (
            <span className="text-xs tabular-nums text-muted-foreground">{step.percent}%</span>
          )}
        </div>
        {step.detail && (
          <p className={cn('mt-0.5 text-xs', isError ? 'text-red-400' : isWarn ? 'text-amber-400' : 'text-muted-foreground')}>
            {step.detail}
          </p>
        )}
        {isActive && step.id === 'download' && (
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-secondary">
            <div
              className="gradient-play h-full rounded-full transition-[width] duration-300"
              style={{ width: `${Math.max(4, step.percent ?? 0)}%` }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Shown before the library UI: runs the runtime bootstrap (first-run install or
 * update) and streams its checklist. The main interface only mounts once this
 * reports success.
 */
export function BootstrapScreen({ onDone }: { onDone: (result: BootstrapResult) => void }) {
  const [steps, setSteps] = useState<BootstrapStep[]>([])
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false

    const unsubscribe = window.api.onBootstrapStep((step) => {
      if (cancelled) return
      setSteps((prev) => {
        const index = prev.findIndex((s) => s.id === step.id)
        if (index === -1) return [...prev, step]
        const next = [...prev]
        next[index] = step
        return next
      })
    })

    const run = async (): Promise<void> => {
      setError(null)
      const started = Date.now()
      const result = await window.api.runBootstrap()
      // Don't flash the screen for a fraction of a second on quick checks.
      const elapsed = Date.now() - started
      if (elapsed < 750) await new Promise((resolve) => setTimeout(resolve, 750 - elapsed))
      if (cancelled) return
      if (result.ok) {
        onDone(result)
      } else {
        setError(result.error ?? 'Runtime setup failed.')
      }
    }

    void run()

    return () => {
      cancelled = true
      unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt])

  return (
    <div className="app-bg flex h-screen items-center justify-center overflow-hidden bg-background">
      <div className="w-full max-w-md px-8">
        <div className="mb-9 flex flex-col items-center text-center">
          <img src="logo.png" alt="NovaPS5" className="h-16 w-16 rounded-2xl shadow-xl shadow-primary/20" />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight">
            Nova<span className="text-primary">PS5</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {error ? 'Runtime setup needs attention' : 'Preparing the conversion runtime…'}
          </p>
        </div>

        <div className="space-y-2.5">
          {steps.length === 0 && !error && (
            <StepRow step={{ id: 'check', label: STEP_META.check.label, status: 'active' }} />
          )}
          {steps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </div>

        {error && (
          <div className="mt-5 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        <div className="mt-7 flex items-center justify-center gap-3">
          {error ? (
            <Button onClick={() => setAttempt((n) => n + 1)}>
              <RefreshCw className="h-4 w-4" /> Try again
            </Button>
          ) : (
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <Circle className="h-1.5 w-1.5 animate-pulse fill-primary text-primary" />
              NovaPS5 will open when this finishes
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
