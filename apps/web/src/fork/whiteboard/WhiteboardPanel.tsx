import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import { boardUrl, showBoard } from "./boardChannel";
import { useBoardHostRole, useBoardOfferedFor, useThreadProjectRoot } from "./role";

/** The right panel's Whiteboard tab: the project's board, which stays loaded while the tab is hidden. */
export function WhiteboardPanel(props: { readonly threadRef: ScopedThreadRef }) {
  const role = useBoardHostRole();
  const projectRoot = useThreadProjectRoot(props.threadRef);
  const offered = useBoardOfferedFor(props.threadRef, projectRoot);
  if (role === "unknown") return null;
  if (!offered || projectRoot === null) {
    return (
      <p className="p-4 text-center text-muted-foreground text-sm">
        The whiteboard is not available here.
      </p>
    );
  }
  return (
    <BoardSlot
      key={projectRoot}
      url={boardUrl(projectRoot)}
      threadKey={scopedThreadKey(props.threadRef)}
    />
  );
}

function BoardSlot(props: { readonly url: string; readonly threadKey: string }) {
  const [ready, setReady] = useState(false);
  // The React Compiler keeps this callback stable, so a re-render does not park and show the board.
  const attachBoard = (slot: HTMLDivElement | null) =>
    slot === null
      ? undefined
      : showBoard(slot, { url: props.url, threadKey: props.threadKey, onReady: setReady });
  return (
    <div className="relative flex min-h-0 flex-1">
      <div ref={attachBoard} className="absolute inset-0" />
      {ready ? null : (
        <p className="absolute inset-x-0 top-1/3 text-center text-muted-foreground text-sm">
          Loading board...
        </p>
      )}
    </div>
  );
}
