import type { ScopedThreadRef } from "@t3tools/contracts";
import { flushSync } from "react-dom";
import { dispatchCommandPalette } from "../commandPaletteStore";
import { cancelLayoutDrag, dropLayoutDrag, moveLayoutDrag } from "../layout/layoutDrag";
import { SidebarPointerSensor } from "./Sidebar.pointer";
import {
  dropThreadContext,
  endThreadContextDrag,
  moveThreadContextDrag,
} from "./chat/threadContextDrag";

export function startPaletteThreadDrag(
  event: PointerEvent,
  thread: ScopedThreadRef,
  title: string,
) {
  if (!event.isPrimary || event.button !== 0 || event.pointerType === "touch") return;
  // The document-owned sensor must survive closing and unmounting the palette on activation.
  return new SidebarPointerSensor({
    event,
    active: `${thread.environmentId}:${thread.threadId}`,
    options: {
      distance: 6,
      onAttach: () => {},
      onFinish: () => {
        endThreadContextDrag();
        cancelLayoutDrag();
      },
      onDrop: (point) => dropThreadContext(point, [{ ...thread, title }]) || dropLayoutDrag(),
    },
    onStart: () => {
      flushSync(() => dispatchCommandPalette({ _tag: "SetOpen", open: false }));
    },
    onMove: (point) =>
      moveLayoutDrag({ kind: "thread", threadRef: thread }, point, {
        composer: moveThreadContextDrag(point, { title, count: 1 }),
      }),
    onPending: () => {},
    onAbort: () => {},
    onCancel: () => {},
    onEnd: () => {},
  });
}
