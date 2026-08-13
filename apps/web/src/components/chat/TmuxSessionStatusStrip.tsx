import { type EnvironmentId, type TmuxSession } from "@t3tools/contracts";
import { PanelsTopLeft } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { subscribeTmuxSessionsChanged } from "../../terminal/tmuxSessionEvents";

interface TmuxSessionStatusStripProps {
  environmentId: EnvironmentId;
  refreshKey: string;
  onOpenSessions: (sessions: ReadonlyArray<TmuxSession>) => void;
}

function StatusContents({ count }: { count: number }) {
  return (
    <>
      <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
      <PanelsTopLeft className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 truncate text-left">
        {count === 1 ? "1 background session running" : `${count} background tasks running`}
      </span>
    </>
  );
}

export function TmuxSessionStatusStrip({
  environmentId,
  refreshKey,
  onOpenSessions,
}: TmuxSessionStatusStripProps) {
  const listTmuxSessions = useAtomCommand(terminalEnvironment.listTmuxSessions, {
    label: "tmux session discovery",
    reportFailure: false,
  });
  const [sessions, setSessions] = useState<ReadonlyArray<TmuxSession>>([]);
  const refreshSequenceRef = useRef(0);

  const refresh = useCallback(async () => {
    const refreshSequence = refreshSequenceRef.current + 1;
    refreshSequenceRef.current = refreshSequence;
    const result = await listTmuxSessions({ environmentId, input: {} });
    if (refreshSequenceRef.current !== refreshSequence) return;
    setSessions(
      result._tag === "Success" && result.value.status === "available" ? result.value.sessions : [],
    );
  }, [environmentId, listTmuxSessions]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  useEffect(() => subscribeTmuxSessionsChanged(() => void refresh()), [refresh]);

  if (sessions.length === 0) return null;

  const className =
    "pointer-events-auto flex h-6 min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-t-[10px] border border-b-0 border-border/70 bg-card/95 px-2.5 text-xs font-medium text-foreground shadow-sm backdrop-blur transition-colors hover:bg-accent";
  const onlySession = sessions.length === 1 ? sessions[0] : undefined;

  return (
    <div className="relative z-0 -mb-px mx-auto flex w-[calc(100%-2.75rem)] max-w-[calc(48rem-2.75rem)] justify-end pe-2">
      <button
        type="button"
        className={className}
        aria-label={onlySession ? `Open tmux session ${onlySession.name}` : "Open tmux sessions"}
        onClick={() => onOpenSessions(sessions)}
      >
        <StatusContents count={sessions.length} />
      </button>
    </div>
  );
}
