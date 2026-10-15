import { useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Library, Settings, Plus, Cpu } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useLibrary } from '@/store/useLibrary'
import { Button } from '@/components/ui/button'

function NavItem({
  icon: Icon,
  label,
  active,
  onClick
}: {
  icon: LucideIcon
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200',
        active
          ? 'bg-primary/10 text-primary shadow-[inset_0_1px_0_0_hsl(var(--primary)/0.15)]'
          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
      )}
    >
      <span
        className={cn(
          'absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-primary transition-opacity duration-200',
          active ? 'opacity-100' : 'opacity-0'
        )}
      />
      <Icon className={cn('h-4 w-4 transition-transform duration-200', !active && 'group-hover:scale-105')} />
      {label}
    </button>
  )
}

export function Sidebar() {
  const { view, setView, setInstallOpen, appInfo } = useLibrary()
  const [logoOk, setLogoOk] = useState(true)
  const toolsReady = !!appInfo && appInfo.relinkerPresent && appInfo.libsPresent && !!appInfo.pythonPath

  return (
    <aside className="relative flex w-64 shrink-0 flex-col border-r border-border/60 bg-card/40 backdrop-blur-sm">
      {/* Brand */}
      <div className="px-5 pb-5 pt-6">
        {logoOk ? (
          <img
            src="logo.png"
            alt="NovaPS5"
            draggable={false}
            onError={() => setLogoOk(false)}
            className="brand-glow h-auto w-full max-w-[170px] select-none"
          />
        ) : (
          <div className="text-xl font-semibold tracking-tight">
            Nova<span className="text-primary">PS5</span>
          </div>
        )}
        <div className="mt-3 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80">
          <span className="h-1 w-1 rounded-full bg-primary" />
          Powered by Nova Crafted
        </div>
      </div>

      <div className="gradient-line mx-4 h-px" />

      <nav className="flex flex-1 flex-col gap-1 p-3">
        <NavItem icon={Library} label="Library" active={view === 'library'} onClick={() => setView('library')} />
        <NavItem icon={Settings} label="Settings" active={view === 'settings'} onClick={() => setView('settings')} />
      </nav>

      <div className="space-y-3 border-t border-border/60 p-3">
        <Button size="lg" className="w-full rounded-xl" onClick={() => setInstallOpen(true)}>
          <Plus className="h-4 w-4" /> Install game
        </Button>
        <div className="flex items-center gap-2 rounded-xl border border-border/50 bg-secondary/40 px-3 py-2">
          <Cpu className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-[11px] text-muted-foreground">
            {toolsReady ? 'Conversion tools ready' : 'Setup needed'}
          </span>
          <span
            className={cn(
              'ml-auto h-2 w-2 shrink-0 rounded-full',
              toolsReady ? 'bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400/60' : 'bg-amber-400'
            )}
          />
        </div>
      </div>
    </aside>
  )
}
