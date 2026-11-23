import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { AuthTerminalOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { T } from "gt-react";
import { memo } from "react";

import { Button } from "~/components/ui/button";
import {
  selectClaimedTerminalIds,
  useRightPanelStore,
  type TerminalPanelSurface,
} from "~/rightPanelStore";
import { useEnvironmentScope } from "~/state/session";
import { useTerminalDrawerSessions } from "~/state/terminalSessions";

import type { RightPanelTerminalProps } from "./chat/RightPanelSurfaceContent";
import { PersistentThreadTerminalPanel } from "./PersistentThreadTerminals";
import { currentTerminalClaims, terminalSurfaceMount } from "./RightPanelTabs.logic";
import { useThreadTerminalActions } from "./terminal/useThreadTerminalActions";

export interface RightPanelTerminalBodyProps {
  threadRef: ScopedThreadRef;
  surface: TerminalPanelSurface;
  visible: boolean;
  terminal: RightPanelTerminalProps;
}

/** A drawer sub-tab's terminal, mounted only when attaching to it cannot start a new shell. */
export const RightPanelTerminalBody = memo(function RightPanelTerminalBody(
  props: RightPanelTerminalBodyProps,
) {
  const { threadRef, surface } = props;
  const listing = useTerminalDrawerSessions(threadRef.environmentId, threadRef.threadId);
  const claimedIds = useRightPanelStore((state) => selectClaimedTerminalIds(state, threadRef));
  const observedSnapshotId = useRightPanelStore(
    (state) => state.terminalServerObservationByThreadKey[scopedThreadKey(threadRef)]?.snapshotId,
  );
  // Without read access the list never arrives, and the id may be live: Restart would replace
  // it, so an unclaimed sub-tab stays pending rather than ended.
  const serverIds = listing?.sessions.map((session) => session.target.terminalId) ?? null;
  const mount = terminalSurfaceMount({
    terminalIds: surface.terminalIds,
    serverIds,
    claimedIds: currentTerminalClaims({
      claimedIds,
      observedSnapshotId,
      serverSnapshotId: listing?.snapshotId,
    }),
  });
  if (mount.kind === "mount") {
    const { terminalIds } = mount;
    return (
      <PersistentThreadTerminalPanel
        {...props.terminal}
        visible={props.visible}
        threadRef={threadRef}
        surface={
          terminalIds.length === surface.terminalIds.length
            ? surface
            : {
                ...surface,
                terminalIds,
                activeTerminalId: terminalIds.includes(surface.activeTerminalId)
                  ? surface.activeTerminalId
                  : terminalIds[0]!,
              }
        }
      />
    );
  }
  if (mount.kind === "ended") return <EndedTerminal threadRef={threadRef} surface={surface} />;
  return null;
});

function EndedTerminal(props: { threadRef: ScopedThreadRef; surface: TerminalPanelSurface }) {
  const terminalActions = useThreadTerminalActions(props.threadRef);
  const canOperate = useEnvironmentScope(props.threadRef.environmentId, AuthTerminalOperateScope);
  const restart = () => {
    for (const terminalId of props.surface.terminalIds) {
      const launched = terminalActions.launchTerminal({
        terminalId,
        place: (id) => useRightPanelStore.getState().openTerminal(props.threadRef, id),
      });
      if (launched) void launched.result;
    }
  };
  // The server no longer has this terminal, so closing only forgets the sub-tab.
  const close = () => useRightPanelStore.getState().closeSurface(props.threadRef, props.surface.id);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center text-sm text-muted-foreground">
      <p>
        <T>This terminal has ended.</T>
      </p>
      <div className="flex items-center gap-2">
        <Button size="xs" variant="outline" disabled={!canOperate} onClick={restart}>
          <T>Restart terminal</T>
        </Button>
        <Button size="xs" variant="ghost" onClick={close}>
          <T>Close</T>
        </Button>
      </div>
    </div>
  );
}
