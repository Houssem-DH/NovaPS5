import type { LucideIcon } from 'lucide-react'
import { Library, Settings, Plus, Gamepad2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useLibrary } from '@/store/useLibrary'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'

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
        'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
        active ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  )
}

export function Sidebar() {
  const { view, setView, setInstallOpen, appInfo } = useLibrary()
  const toolsReady = !!appInfo && appInfo.relinkerPresent && appInfo.libsPresent && !!appInfo.pythonPath

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border/60 bg-card/30">
      <div className="flex items-center gap-3 px-5 py-5">
        <div className="gradient-play flex h-10 w-10 items-center justify-center rounded-xl shadow-lg shadow-primary/20">
          <Gamepad2 className="h-5 w-5 text-white" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight">PS5 Library</div>
          <div className="text-[11px] text-muted-foreground">Powered by AnyPS5</div>
        </div>
      </div>

      <Separator />

      <nav className="flex flex-1 flex-col gap-1 p-3">
        <NavItem icon={Library} label="Library" active={view === 'library'} onClick={() => setView('library')} />
        <NavItem icon={Settings} label="Settings" active={view === 'settings'} onClick={() => setView('settings')} />
      </nav>

      <div className="space-y-3 p-3">
        <Button className="w-full" onClick={() => setInstallOpen(true)}>
          <Plus className="h-4 w-4" /> Install game
        </Button>
        <div className="flex items-center gap-2 px-1 text-[11px] text-muted-foreground">
          <span className={cn('h-2 w-2 rounded-full', toolsReady ? 'bg-emerald-400' : 'bg-amber-400')} />
          {toolsReady ? 'Conversion tools ready' : 'Check settings'}
        </div>
      </div>
    </aside>
  )
}
