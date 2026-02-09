import { useStore } from "../store";

export default function DiffPanel() {
  const { dispatch } = useStore();

  return (
    <aside className="flex h-full w-[400px] shrink-0 flex-col border-l border-border bg-card">
      {/* Header */}
      <div className="drag-region flex items-center justify-between border-b border-border px-4 pt-[28px] pb-3">
        <h3 className="text-xs font-medium text-foreground">Uncommitted changes</h3>
        <button
          type="button"
          className="text-muted-foreground/60 transition-colors duration-150 hover:text-muted-foreground"
          onClick={() => dispatch({ type: "TOGGLE_DIFF" })}
        >
          <span className="text-sm">&times;</span>
        </button>
      </div>

      {/* Placeholder content */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="space-y-3">
          <div className="rounded-lg border border-border/80 bg-muted p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-medium text-emerald-400">
                M
              </span>
              <span className="font-mono text-xs text-muted-foreground/80">src/App.tsx</span>
            </div>
            <div className="space-y-0.5 font-mono text-[11px]">
              <div className="text-red-400/60">- const oldValue = "hello";</div>
              <div className="text-emerald-400/60">+ const newValue = "world";</div>
            </div>
          </div>

          <div className="rounded-lg border border-border/80 bg-muted p-3">
            <div className="flex items-center gap-2">
              <span className="rounded bg-blue-500/20 px-1.5 py-0.5 text-[9px] font-medium text-blue-400">
                A
              </span>
              <span className="font-mono text-xs text-muted-foreground/80">src/utils.ts</span>
            </div>
          </div>
        </div>

        <p className="mt-6 text-center text-[10px] text-muted-foreground/30">
          Diff integration coming soon
        </p>
      </div>
    </aside>
  );
}
