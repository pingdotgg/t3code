import type { IssueListEntry } from "@t3tools/contracts";
import { CircleDot } from "lucide-react";

/**
 * The results under the box, in Orca's popover: rows of an icon, the key in bold and the title,
 * three pulsing rows while an answer loads, and a centred hint when there is nothing to list.
 * A press on a row never takes focus from the box.
 */
export function IssueResults({
  rows,
  loading,
  error,
  hint,
  highlight,
  onHighlight,
  onPick,
  action,
}: {
  rows: ReadonlyArray<IssueListEntry>;
  loading: boolean;
  error: string | null;
  hint: string;
  highlight: number;
  onHighlight: (index: number) => void;
  onPick: (entry: IssueListEntry) => void;
  action: { readonly label: string; readonly run: () => void } | null;
}) {
  return (
    <div
      data-testid="issue-results"
      onMouseDown={(event) => event.preventDefault()}
      className="absolute top-full right-0 left-0 z-20 mt-1 max-h-32 overflow-y-auto rounded-md border border-line bg-panel shadow-panel"
    >
      {rows.length > 0 ? (
        <ul role="listbox" className="p-1">
          {rows.map((entry, index) => (
            <li
              key={`${entry.scope}#${entry.key}`}
              role="option"
              aria-selected={index === highlight}
              onMouseEnter={() => onHighlight(index)}
              onClick={() => onPick(entry)}
              className={`flex cursor-pointer items-center gap-2 rounded px-3 py-2 text-xs ${index === highlight ? "bg-hover" : ""}`}
            >
              <CircleDot className="size-3.5 shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 truncate">
                <span className="font-medium text-fg">{entry.displayKey} </span>
                {entry.title}
              </span>
            </li>
          ))}
        </ul>
      ) : loading ? (
        <div className="space-y-1 p-1" aria-label="Loading results">
          {[0, 1, 2].map((index) => (
            <div key={index} className="h-8 animate-pulse rounded bg-hover" />
          ))}
        </div>
      ) : (
        <div role="status" className="px-3 py-6 text-center text-xs text-muted">
          {error ?? hint}
          {action !== null && (
            <button
              type="button"
              onClick={action.run}
              className="mt-2 block w-full text-center text-focus underline-offset-2 hover:underline"
            >
              {action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
