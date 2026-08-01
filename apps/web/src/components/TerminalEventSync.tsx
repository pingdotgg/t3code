"use client";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId, type TerminalMetadataStreamEvent } from "@t3tools/contracts";
import { memo, useEffect, useRef } from "react";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { terminalEnvironment } from "../state/terminal";
import { useEnvironmentQuery } from "../state/query";
import { useTerminalUiStateStore } from "../terminalUiStateStore";

export function applyTerminalRemovedEvent(
  environmentId: EnvironmentId,
  event: Extract<TerminalMetadataStreamEvent, { type: "remove" }>,
): void {
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
  const terminalRemovals = useEnvironmentQuery(
    terminalEnvironment.removals({
      environmentId,
      input: {},
    }),
  );
  const appliedRef = useRef({ environmentId, count: 0 });

  useEffect(() => {
    const removals = terminalRemovals.data;
    if (!removals) return;
    if (appliedRef.current.environmentId !== environmentId) {
      appliedRef.current = { environmentId, count: 0 };
    }
    // The stream accumulates removals so none are lost between commits; a
    // shrinking array means the subscription restarted from scratch.
    if (removals.length < appliedRef.current.count) appliedRef.current.count = 0;
    for (const event of removals.slice(appliedRef.current.count)) {
      applyTerminalRemovedEvent(environmentId, event);
    }
    appliedRef.current.count = removals.length;
  }, [environmentId, terminalRemovals.data]);

  return null;
});
