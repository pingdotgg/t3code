import {
  formatWorkingDurationLabel,
  resolveThreadWorkingStartedAt,
} from "@t3tools/client-runtime/state/models";
import {
  seatActivityLabel,
  type ThreadGroup,
  type ThreadGroupSeat,
} from "@t3tools/client-runtime/state/thread-group";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ChevronRightIcon, XIcon } from "lucide-react";
import { useGT, useMessages } from "gt-react";

import { tickTextContent } from "~/lib/tickTextContent";
import { useRightPanelStore } from "~/rightPanelStore";
import {
  useQuietThreadProjection,
  useQuietThreadShell,
  useRunningGroupSeats,
} from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentScope } from "~/state/session";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { Button } from "../ui/button";

/** Mounted only while the seat has an open run, so it holds a thread subscription no longer. */
function SeatLiveRow(props: { parentRef: ScopedThreadRef; seat: ThreadGroupSeat }) {
  const gt = useGT();
  const m = useMessages();
  const { parentRef, seat } = props;
  const seatRef = scopeThreadRef(parentRef.environmentId, seat.threadId);
  const shell = useQuietThreadShell(seatRef);
  const projection = useQuietThreadProjection(seatRef)?.projection;
  const canOperate = useEnvironmentScope(parentRef.environmentId, AuthOrchestrationOperateScope);
  const interrupt = useAtomCommand(threadEnvironment.interruptTurn);
  const startedAt = shell === null ? null : resolveThreadWorkingStartedAt(shell);
  const activity = seatActivityLabel(projection?.turnItems ?? [], shell?.runtime?.activeRunId, m);
  return (
    <div className="chat-content-lane flex min-w-0 items-center gap-2 py-0.5 text-xs text-muted-foreground">
      <span className="shrink-0 font-medium text-foreground/85">{seat.label}</span>
      <span className="min-w-0 truncate">
        {activity}
        {startedAt === null ? null : (
          <>
            {", "}
            <span
              ref={tickTextContent(
                (nowMs) => formatWorkingDurationLabel(nowMs - Date.parse(startedAt)),
                true,
              )}
              className="tabular-nums"
            />
          </>
        )}
      </span>
      <span className="ms-auto flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost-muted"
          size="compact"
          aria-label={gt("Open {label}'s work", { label: seat.label })}
          onClick={() => useRightPanelStore.getState().openThread(parentRef, seat.threadId)}
        >
          {gt("work", { $context: "noun, opens the group member's work" })}
          <ChevronRightIcon />
        </Button>
        <Button
          variant="ghost-destructive"
          size="icon-xs"
          aria-label={gt("Stop {label}", { label: seat.label })}
          disabled={!canOperate}
          onClick={() =>
            void interrupt({
              environmentId: parentRef.environmentId,
              input: { threadId: seat.threadId },
            })
          }
        >
          <XIcon />
        </Button>
      </span>
    </div>
  );
}

/** One row per seat with an open run, below the timeline's tail. The seat's tools stay in its pane. */
export function GroupLiveRow(props: { threadRef: ScopedThreadRef; group: ThreadGroup }) {
  const running = useRunningGroupSeats(props.threadRef);
  if (running.length === 0) return null;
  return (
    <>
      {props.group.seats
        .filter((seat) => running.includes(seat.threadId))
        .map((seat) => (
          <SeatLiveRow key={seat.threadId} parentRef={props.threadRef} seat={seat} />
        ))}
    </>
  );
}
