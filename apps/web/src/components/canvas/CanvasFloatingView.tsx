import type { ScopedThreadRef } from "@t3tools/contracts";
import { T } from "gt-react";
import { useEffect, useSyncExternalStore } from "react";

import { Spinner } from "~/components/ui/spinner";
import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { definePluginComponent } from "~/plugins/features";

import type { CanvasDocumentController } from "./canvasDocumentStore";
import { CanvasEditor } from "./CanvasEditor";
import { useCanvasDocument } from "./CanvasPanel";

export const CanvasFloatingView = definePluginComponent(
  "component:components/canvas/CanvasFloatingView",
  PluginOriginalCanvasFloatingView,
);

/** The canvas inside the floating player: pan and zoom only. */
function PluginOriginalCanvasFloatingView(props: {
  readonly threadRef: ScopedThreadRef;
  readonly documentId: string;
}) {
  const controller = useCanvasDocument(props.threadRef.environmentId, props.documentId);
  return controller ? (
    <FloatingContent threadRef={props.threadRef} controller={controller} />
  ) : null;
}

function FloatingContent(props: {
  readonly threadRef: ScopedThreadRef;
  readonly controller: CanvasDocumentController;
}) {
  const { threadRef, controller } = props;
  const status = useSyncExternalStore(controller.subscribe, controller.getStatus);
  // A deleted canvas closes its player, like a device player when its session ends.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the floating player when the document subscription reports the canvas deleted, possibly by another client
  useEffect(() => {
    if (status === "deleted") usePreviewMiniPlayerStore.getState().close(threadRef);
  }, [status, threadRef]);
  if (status !== "ready") {
    return (
      <div className="flex size-full items-center justify-center text-xs text-muted-foreground">
        {status === "loading" ? (
          <span className="flex items-center gap-2">
            <Spinner size="xs" /> <T>Loading canvas…</T>
          </span>
        ) : (
          <T>Canvas unavailable</T>
        )}
      </div>
    );
  }
  return <CanvasEditor controller={controller} variant="floating" />;
}
