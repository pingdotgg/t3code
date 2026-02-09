import { useStore } from "../store";

export default function DiffPanel() {
  const { dispatch } = useStore();

  return (
    <aside className="flex h-full w-[400px] shrink-0 flex-col border-l border-white/[0.08] bg-[#141414]">
      {/* Header */}
      <div className="drag-region flex items-center justify-between border-b border-white/[0.08] px-4 pt-[28px] pb-3">
        <h3 className="text-xs font-medium text-[#e0e0e0]">Uncommitted changes</h3>
        <button
          type="button"
          className="text-[#a0a0a0]/40 transition-colors duration-150 hover:text-[#a0a0a0]/70"
          onClick={() => dispatch({ type: "TOGGLE_DIFF" })}
        >
          <span className="text-sm">&times;</span>
        </button>
      </div>

      {/* Placeholder content */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="space-y-3">
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-medium text-emerald-400">
                M
              </span>
              <span className="font-mono text-xs text-[#a0a0a0]/60">src/App.tsx</span>
            </div>
            <div className="space-y-0.5 font-mono text-[11px]">
              <div className="text-red-400/60">- const oldValue = "hello";</div>
              <div className="text-emerald-400/60">+ const newValue = "world";</div>
            </div>
          </div>

          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
            <div className="flex items-center gap-2">
              <span className="rounded bg-blue-500/20 px-1.5 py-0.5 text-[9px] font-medium text-blue-400">
                A
              </span>
              <span className="font-mono text-xs text-[#a0a0a0]/60">src/utils.ts</span>
            </div>
          </div>
        </div>

        <p className="mt-6 text-center text-[10px] text-[#a0a0a0]/25">
          Diff integration coming soon
        </p>
      </div>
    </aside>
  );
}
