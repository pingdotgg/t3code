import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import { registerBoardFrame } from "./boardChannel";
import { useBoardHostRole, useBoardOfferedFor, useThreadProjectRoot } from "./role";

/** The right panel's Whiteboard tab: the project's board, framed from the board page. */
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
    <BoardFrame
      key={projectRoot}
      threadKey={scopedThreadKey(props.threadRef)}
      projectRoot={projectRoot}
    />
  );
}

function BoardFrame(props: { readonly threadKey: string; readonly projectRoot: string }) {
  const [ready, setReady] = useState(false);
  // The React Compiler keeps this callback stable, so a re-render does not unregister the frame
  // (which drops a click still waiting for it).
  const registerFrame = (element: HTMLIFrameElement | null) =>
    element === null
      ? undefined
      : registerBoardFrame(element, props.threadKey, () => setReady(true));
  return (
    <div className="relative flex min-h-0 flex-1">
      {ready ? null : (
        <p className="absolute inset-x-0 top-1/3 text-center text-muted-foreground text-sm">
          Loading board...
        </p>
      )}
      {/* oxlint-disable-next-line react/iframe-missing-sandbox -- the board is this origin's own page; it needs scripts and same-origin storage, which together make a sandbox moot. */}
      <iframe
        ref={registerFrame}
        title="Whiteboard"
        src={`/?embed=panel&room=${encodeURIComponent(props.projectRoot)}`}
        className="size-full border-0"
      />
    </div>
  );
}
