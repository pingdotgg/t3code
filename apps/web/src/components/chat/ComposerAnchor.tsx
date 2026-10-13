import type { CSSProperties, ReactNode, Ref } from "react";
import { createPortal } from "react-dom";

/**
 * Where a chat view's composer renders. One composer per thread is visible: a
 * side chat with focus renders its composer in its parent's slot, and the
 * parent's own composer hides meanwhile.
 */
export type ComposerAnchorPlacement =
  | {
      readonly kind: "host";
      /** A side chat has this thread's composer. */
      readonly hidden: boolean;
    }
  | {
      readonly kind: "side-chat";
      readonly threadId: string;
      readonly focused: boolean;
      /** The parent's slot; null where the parent column is out of view, so it stays in place. */
      readonly slot: HTMLElement | null;
      /** Shown instead of the composer while the parent has it. */
      readonly replyBar: ReactNode;
    };

export function ComposerAnchor(props: {
  readonly anchorRef: Ref<HTMLDivElement>;
  /** Host only: the slot below the composer where a focused side chat's composer renders. */
  readonly slotRef?: Ref<HTMLDivElement> | undefined;
  readonly style?: CSSProperties | undefined;
  readonly placement: ComposerAnchorPlacement;
  readonly children: ReactNode;
}) {
  const { anchorRef, slotRef, style, placement, children } = props;
  if (placement.kind === "side-chat" && !placement.focused) return placement.replyBar;
  const anchor = (
    <div
      ref={anchorRef}
      hidden={placement.kind === "host" && placement.hidden}
      className="relative z-10"
      style={style}
    >
      {children}
    </div>
  );
  if (placement.kind === "host") {
    return (
      <>
        {anchor}
        <div ref={slotRef} />
      </>
    );
  }
  if (placement.slot === null) return anchor;
  // Window-level shortcuts tell chats apart by this attribute, and the portaled
  // composer no longer sits inside the side chat's own root.
  return createPortal(<div data-chat-embedded={placement.threadId}>{anchor}</div>, placement.slot);
}
