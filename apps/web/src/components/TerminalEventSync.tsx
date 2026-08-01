"use client";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId, type TerminalEvent } from "@t3tools/contracts";
import { memo, useEffect, useRef } from "react";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { terminalEnvironment } from "../state/terminal";
import { useEnvironmentQuery } from "../state/query";
import { useTerminalUiStateStore } from "../terminalUiStateStore";

export function applyTerminalClosedEvent(environmentId: EnvironmentId, event: TerminalEvent): void {
  if (event.type !== "closed") return;

  const threadRef = scopeThreadRef(environmentId, ThreadId.make(event.threadId));
  useTerminalUiStateStore.getState().removeTerminalFromServer(threadRef, event.terminalId);

  const rightPanelStore = useRightPanelStore.getState();
  const terminalSurfaces = selectThreadRightPanelState(
    rightPanelStore.byThreadKey,
    threadRef,
  ).surfaces.filter(
    (surface) => surface.kind === "terminal" && surface.terminalIds.includes(event.terminalId),
  );
  for (const surface of terminalSurfaces) {
    rightPanelStore.closeTerminal(threadRef, surface.id, event.terminalId);
  }
}

export const TerminalEventSync = memo(function TerminalEventSync({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const terminalEvent = useEnvironmentQuery(
    terminalEnvironment.events({
      environmentId,
      input: {},
    }),
  );
  const appliedCountRef = useRef(0);

  useEffect(() => {
    const closedEvents = terminalEvent.data;
    if (!closedEvents) return;
    // The stream accumulates closed events so none are lost between commits; a
    // shrinking array means the subscription restarted from scratch.
    if (closedEvents.length < appliedCountRef.current) appliedCountRef.current = 0;
    for (const event of closedEvents.slice(appliedCountRef.current)) {
      applyTerminalClosedEvent(environmentId, event);
    }
    appliedCountRef.current = closedEvents.length;
  }, [environmentId, terminalEvent.data]);

  return null;
});
