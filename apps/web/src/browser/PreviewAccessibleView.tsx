import {
  type AccessibleDocumentView,
  createAccessibleDocumentView,
} from "@t3tools/client-runtime/preview/accessible-document";
import type { PreviewAccessibilityAction, PreviewAccessibilityDocument } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";

export interface PreviewAccessibleNotice {
  readonly message: string;
  readonly id: number;
}

/** The streamed page as a readable document, drawn by the renderer the mobile viewer shares. */
export function PreviewAccessibleView(props: {
  readonly document: PreviewAccessibilityDocument | null;
  readonly canAct: boolean;
  readonly notice: PreviewAccessibleNotice | null;
  readonly onAction: (action: PreviewAccessibilityAction) => boolean;
}) {
  const { document, canAct, notice } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<AccessibleDocumentView | null>(null);
  const act = useEffectEvent((action: PreviewAccessibilityAction) => props.onAction(action));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns the imperative DOM the shared renderer keys by node id.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const view = createAccessibleDocumentView(container, { onAction: (action) => act(action) });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Updates in place so focus and edits survive new snapshots.
  useEffect(() => {
    viewRef.current?.update(document, canAct);
  }, [document, canAct]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Server notices go to the view's own live region.
  useEffect(() => {
    if (notice) viewRef.current?.notice(notice.message);
  }, [notice]);

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label="Accessible view of the page"
      className="absolute inset-0 z-10 overflow-auto bg-background text-sm text-foreground"
    />
  );
}
