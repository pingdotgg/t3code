/** The panel's title strip, in the chrome Orca gives its side panels. */
export function PanelHeader({ title, status }: { title: string; status: string }) {
  return (
    <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
      <span className="font-medium text-fg">Orchestrator</span>
      <span className="min-w-0 flex-1 truncate text-muted">{title}</span>
      <span data-testid="orchestrator-status" className="text-[11px] text-muted">
        {status}
      </span>
    </header>
  );
}
