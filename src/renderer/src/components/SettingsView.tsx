import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  CheckCircle2,
  Database,
  FolderOpen,
  Loader2,
  Package,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Wrench,
  XCircle
} from 'lucide-react'
import { useLibrary } from '@/store/useLibrary'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

function Section({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <section className="mb-8">
      <div className="mb-3">
        <h2 className="section-label">{title}</h2>
        {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
      </div>
      <div className="space-y-2.5">{children}</div>
    </section>
  )
}

function Row({
  icon: Icon,
  label,
  value,
  ok,
  badge,
  action
}: {
  icon: typeof FolderOpen
  label: string
  value: string
  ok?: boolean
  badge?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="panel flex items-start gap-3.5 p-4 transition-colors hover:border-border">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-secondary/70">
        <Icon className="h-4 w-4 text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {label}
          {badge}
          {ok !== undefined &&
            (ok ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            ) : (
              <XCircle className="h-4 w-4 text-red-400" />
            ))}
        </div>
        <div className="mt-1 break-all text-xs text-muted-foreground">{value}</div>
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  )
}

function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'muted'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'rounded-full border px-2 py-0.5 text-[11px] font-medium',
        tone === 'ok' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
        tone === 'warn' && 'border-amber-500/30 bg-amber-500/10 text-amber-300',
        tone === 'muted' && 'border-border bg-secondary/60 text-muted-foreground'
      )}
    >
      {children}
    </span>
  )
}

export function SettingsView() {
  const { appInfo, refreshInfo } = useLibrary()
  const [checking, setChecking] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [moving, setMoving] = useState(false)
  const [runtimeMsg, setRuntimeMsg] = useState<string | null>(null)
  const [gamesMsg, setGamesMsg] = useState<string | null>(null)

  useEffect(() => {
    void refreshInfo()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const recheck = async (): Promise<void> => {
    setChecking(true)
    await refreshInfo()
    setChecking(false)
  }

  // "Scan for updates" (re)checks the repo and only downloads when a newer
  // runtime exists — an up-to-date runtime is left untouched.
  const scanForUpdates = async (): Promise<void> => {
    setUpdating(true)
    setRuntimeMsg(null)
    const result = await window.api.runBootstrap()
    setRuntimeMsg(
      result.ok
        ? result.updated
          ? `Runtime updated to v${result.runtimeVersion}.`
          : `Runtime v${result.runtimeVersion ?? 'bundled'} is up to date.`
        : (result.error ?? 'Update check failed.')
    )
    await refreshInfo()
    setUpdating(false)
  }

  const changeGamesDir = async (): Promise<void> => {
    const dir = await window.api.selectFolder()
    if (!dir) return
    if (dir === appInfo?.gamesDir) return
    setMoving(true)
    setGamesMsg(null)
    const result = await window.api.setGamesDir(dir)
    setGamesMsg(
      result.ok
        ? result.moved > 0
          ? `Games folder changed — ${result.moved} game${result.moved === 1 ? '' : 's'} moved.`
          : 'Games folder changed.'
        : (result.error ?? 'Could not change the games folder.')
    )
    await refreshInfo()
    setMoving(false)
  }

  const pythonOk = !!appInfo?.pythonPath
  const toolsOk = !!appInfo?.relinkerPresent && !!appInfo?.libsPresent
  const runtimeOk = toolsOk
  const allOk = pythonOk && toolsOk

  return (
    <div className="max-w-3xl">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">Runtime, storage locations, and conversion tooling.</p>
        </div>
        <Button variant="outline" size="sm" onClick={recheck} disabled={checking}>
          <RefreshCw className={cn('h-4 w-4', checking && 'animate-spin')} /> Re-check
        </Button>
      </div>

      <div
        className={cn(
          'mb-8 flex items-center gap-3 rounded-2xl border p-4 text-sm',
          allOk
            ? 'border-emerald-500/25 bg-emerald-500/[0.07] text-emerald-200'
            : 'border-amber-500/25 bg-amber-500/[0.07] text-amber-200'
        )}
      >
        {allOk ? <ShieldCheck className="h-5 w-5 shrink-0" /> : <XCircle className="h-5 w-5 shrink-0" />}
        <span>
          {allOk
            ? 'Everything is ready — games can be converted and played.'
            : 'Some components are missing. Conversion may fail until they are resolved.'}
        </span>
      </div>

      <Section title="Conversion runtime" description="Downloaded from the AnyPS5 releases; updated automatically.">
        <Row
          icon={Package}
          label="Runtime"
          value={
            appInfo?.runtimeVersion
              ? `v${appInfo.runtimeVersion} · github.com/${appInfo.runtimeRepo}`
              : 'Not installed yet — installs automatically on launch'
          }
          badge={runtimeOk ? <Pill tone="ok">Up to date</Pill> : <Pill tone="warn">Not installed</Pill>}
          action={
            <Button variant="outline" size="sm" onClick={scanForUpdates} disabled={updating}>
              {updating ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {updating ? 'Scanning…' : runtimeOk ? 'Scan for updates' : 'Install runtime'}
            </Button>
          }
        />
        {runtimeMsg && (
          <p className="px-1 text-xs text-muted-foreground" role="status">
            {runtimeMsg}
          </p>
        )}
      </Section>

      <Section title="Storage" description="Where installed games are kept. Changing it moves your existing games.">
        <Row
          icon={FolderOpen}
          label="Games folder"
          value={appInfo?.gamesDir ?? '…'}
          action={
            <Button variant="outline" size="sm" onClick={changeGamesDir} disabled={moving}>
              {moving && <Loader2 className="h-4 w-4 animate-spin" />}
              {moving ? 'Moving games…' : 'Change…'}
            </Button>
          }
        />
        {gamesMsg && (
          <p className="px-1 text-xs text-muted-foreground" role="status">
            {gamesMsg}
          </p>
        )}
        <p className="px-1 text-xs leading-relaxed text-muted-foreground">
          Every already-installed game is relocated into the new folder — large libraries can take a while. Nothing is
          deleted if a move fails.
        </p>
      </Section>

      <Section title="Components" description="Shipped with the app — nothing to install by hand.">
        <Row
          icon={Wrench}
          label="Relinker"
          value={appInfo?.relinkerPresent ? 'relinker.exe present' : 'Missing — it installs automatically on launch'}
          ok={appInfo?.relinkerPresent}
        />
        <Row
          icon={Wrench}
          label="Runtime libraries"
          value={appInfo?.libsPresent ? `${appInfo.toolsDir}\\libs` : 'libs/ folder missing'}
          ok={appInfo?.libsPresent}
        />
        <Row
          icon={Terminal}
          label="Python 3"
          value={
            pythonOk
              ? appInfo?.pythonBundled
                ? 'Bundled with NovaPS5 — no separate install required'
                : `Detected: ${appInfo?.pythonPath}`
              : 'Missing — repair or reinstall NovaPS5'
          }
          ok={pythonOk}
          badge={appInfo?.pythonBundled ? <Pill tone="muted">Bundled</Pill> : undefined}
        />
        <Row
          icon={Database}
          label="Tools folder"
          value={appInfo?.toolsDir ?? '…'}
        />
      </Section>

      <Section title="About">
        <div className="panel p-4 text-xs leading-relaxed text-muted-foreground">
          <p>
            Each install unwraps the game&apos;s SELF modules to ELF, runs the AnyPS5 relinker to build a Windows
            executable, arranges the <code className="rounded bg-secondary px-1">app0/</code> runtime layout, then
            launches the game once to verify it works. Conversion uses your local dump only — nothing is uploaded.
          </p>
        </div>
      </Section>
    </div>
  )
}
