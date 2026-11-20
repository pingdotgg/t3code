import { buttonClass } from "./fileActions";
import type { SaveSession } from "./saveSession";

/** The two sides of a save that found the disk changed, and the choice between them. */
export function FileConflict({
  session,
  busy,
  onKeepMine,
  onTakeTheirs,
}: {
  session: SaveSession;
  busy: boolean;
  onKeepMine: () => void;
  onTakeTheirs: () => void;
}) {
  return (
    <section
      aria-label="Conflict"
      data-testid="save-conflict"
      className="flex min-h-0 flex-1 flex-col gap-2 border-b border-amber-400/40 bg-amber-500/5 p-3"
    >
      <p role="alert" className="text-[12px] text-amber-300">
        This file changed on disk after you opened it. Nothing was written. Choose which side to
        keep.
      </p>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-2">
        {(
          [
            ["Mine", session.edits],
            ["Theirs", session.disk ?? ""],
          ] as const
        ).map(([title, text]) => (
          <div key={title} className="flex min-h-0 flex-col rounded-md border border-line bg-bg">
            <h4 className="border-b border-line px-2 py-1 text-[11px] font-semibold text-muted">
              {title}
            </h4>
            <pre
              data-testid={`conflict-${title.toLowerCase()}`}
              className="min-h-0 flex-1 overflow-auto p-2 font-mono text-[11px] leading-4 whitespace-pre-wrap"
            >
              {text}
            </pre>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={onKeepMine} className={buttonClass}>
          Keep mine
        </button>
        <button type="button" disabled={busy} onClick={onTakeTheirs} className={buttonClass}>
          Take theirs
        </button>
      </div>
    </section>
  );
}
