import { Button } from "../../components/ui/button";
/**
 * Voice history review surface: the list of saved voice sessions with their
 * entry counts, per-session delete, export of everything as JSON, and clear
 * all. Dumb component; the store lives in the recorder owned by the panel.
 */
import type { VoiceHistorySessionSummary } from "../history";

export interface VoiceHistoryProps {
  readonly sessions: ReadonlyArray<VoiceHistorySessionSummary>;
  /** Expanded review list; controlled by the panel. */
  readonly open: boolean;
  readonly onToggle: () => void;
  /** Disabled while a session is live: clearing or deleting mid-session
      would race the recorder's boundary writes. */
  readonly frozen: boolean;
  readonly onExport: () => void;
  readonly onClear: () => void;
  readonly onDelete: (id: string) => void;
}

const formatSession = (summary: VoiceHistorySessionSummary): string => {
  const started = new Date(summary.startedAt);
  const ended = summary.endedAt !== undefined ? new Date(summary.endedAt) : undefined;
  const day = started.toLocaleDateString();
  const time = started.toLocaleTimeString();
  const span =
    ended === undefined
      ? "open"
      : `${Math.max(1, Math.round((ended.getTime() - summary.startedAt) / 1000))}s`;
  return `${day} ${time} (${span}, ${summary.entryCount} entries)`;
};

export function VoiceHistory(props: VoiceHistoryProps) {
  if (props.sessions.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1 text-xs" data-voice-history="">
      <Button
        type="button"
        size="micro"
        variant="ghost-muted"
        aria-expanded={props.open}
        onClick={props.onToggle}
      >
        History ({props.sessions.length})
      </Button>
      {props.open && (
        <>
          <ul className="flex flex-col gap-1">
            {props.sessions.map((summary) => (
              <li key={summary.id} className="flex items-center justify-between gap-2">
                <span className="truncate text-muted-foreground" data-voice-history-session="">
                  {formatSession(summary)}
                </span>
                <Button
                  type="button"
                  size="micro"
                  variant="ghost-muted"
                  disabled={props.frozen}
                  aria-label={`Delete saved session from ${formatSession(summary)}`}
                  onClick={() => props.onDelete(summary.id)}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button type="button" size="micro" variant="outline" onClick={props.onExport}>
              Export history
            </Button>
            <Button
              type="button"
              size="micro"
              variant="ghost-muted"
              disabled={props.frozen}
              onClick={props.onClear}
            >
              Clear history
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
