import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, HostAdmissionState, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ClockIcon } from "lucide-react";
import { memo } from "react";

import { useServerConfigs, useThreadShell } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button, InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

/** Turns held by the host's admission limits would otherwise look like stuck threads. */
export const SidebarHostAdmissionPill = memo(function SidebarHostAdmissionPill() {
  const configs = useServerConfigs();
  const waiting = [...configs].flatMap(([environmentId, config]) =>
    config.hostAdmission !== undefined && config.hostAdmission.waitingTurns > 0
      ? [{ environmentId, admission: config.hostAdmission }]
      : [],
  );
  return (
    <>
      {waiting.map((entry) => (
        <HostAdmissionPill
          key={entry.environmentId}
          environmentId={entry.environmentId}
          admission={entry.admission}
        />
      ))}
    </>
  );
});

function HostAdmissionPill(props: {
  readonly environmentId: EnvironmentId;
  readonly admission: HostAdmissionState;
}) {
  const { admission } = props;
  const running =
    admission.maxRunningTurns === null
      ? `${admission.runningTurns} running`
      : `${admission.runningTurns}/${admission.maxRunningTurns} running`;
  const title = `${admission.waitingTurns} ${admission.waitingTurns === 1 ? "turn" : "turns"} waiting`;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost-muted"
            size="compact"
            data-host-admission={props.environmentId}
            className="w-full shrink-0 justify-start"
          />
        }
      >
        <ClockIcon />
        <span className="min-w-0">{`${title} · ${running}`}</span>
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" padding="compact">
        <div className="w-72 max-w-full">
          <PopoverTitle>{title}</PopoverTitle>
          <p className="mt-1 text-2xs text-muted-foreground">
            The host holds new turns while it is busy. Start one now from its thread.
          </p>
          <ul className="mt-2 flex max-h-60 flex-col gap-1 overflow-y-auto">
            {admission.waitingThreadIds.map((threadId) => (
              <WaitingThreadRow
                key={threadId}
                environmentId={props.environmentId}
                threadId={threadId}
              />
            ))}
          </ul>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function WaitingThreadRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const navigate = useNavigate();
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const thread = useThreadShell(threadRef);
  return (
    <li className="flex min-w-0 text-xs">
      <InlineButton
        className="min-w-0 max-w-full"
        onClick={() =>
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(threadRef),
          })
        }
      >
        <span className="truncate">{thread?.title ?? "Untitled thread"}</span>
      </InlineButton>
    </li>
  );
}
