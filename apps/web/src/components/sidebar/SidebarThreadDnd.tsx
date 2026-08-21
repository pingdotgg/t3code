import { useDroppable } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  createSidebarDndSectionId,
  type SidebarDndPreviewVariant,
  type SidebarDndSection,
} from "../Sidebar.dnd.logic";
import { animatePinnedLayoutChanges } from "../Sidebar.logic";
import { SidebarThreadDragPreview } from "./SidebarThreadDragPreview";

export type SidebarThreadDndRowBag = {
  readonly listeners: ReturnType<typeof useSortable>["listeners"];
  readonly setNodeRef: (node: HTMLElement | null) => void;
  readonly transform: ReturnType<typeof useSortable>["transform"];
  readonly transition: string | undefined;
  readonly isDragging: boolean;
  readonly isSortable: boolean;
};

export function SidebarThreadDndRow(props: {
  threadKey: string;
  dragDisabled: boolean;
  dropDisabled: boolean;
  sortable: boolean;
  onNodeChange: (threadKey: string, node: HTMLElement | null) => void;
  children: (bag: SidebarThreadDndRowBag) => ReactNode;
}) {
  const sortable = useSortable({
    id: props.threadKey,
    disabled: { draggable: props.dragDisabled, droppable: props.dropDisabled },
    ...(props.sortable ? { animateLayoutChanges: animatePinnedLayoutChanges } : {}),
  });
  const setNodeRef = useCallback(
    (node: HTMLElement | null) => {
      sortable.setNodeRef(node);
      props.onNodeChange(props.threadKey, node);
    },
    [props.onNodeChange, props.threadKey, sortable.setNodeRef],
  );
  useEffect(
    () => () => {
      props.onNodeChange(props.threadKey, null);
    },
    [props.onNodeChange, props.threadKey],
  );
  return props.children({
    listeners: sortable.listeners,
    setNodeRef,
    transform: props.sortable ? sortable.transform : null,
    transition: props.sortable ? sortable.transition : undefined,
    isDragging: sortable.isDragging,
    isSortable: props.sortable,
  });
}

export function SidebarThreadSectionDropZone(props: {
  section: SidebarDndSection;
  disabled: boolean;
  children: (bag: {
    readonly setNodeRef: (node: HTMLElement | null) => void;
    readonly isOver: boolean;
  }) => ReactNode;
}) {
  const droppable = useDroppable({
    id: createSidebarDndSectionId({ section: props.section }),
    disabled: props.disabled,
    data: { section: props.section },
  });
  return props.children({ setNodeRef: droppable.setNodeRef, isOver: droppable.isOver });
}

export function SidebarThreadDropIndicator(props: { edge: "before" | "after" }) {
  return (
    <span
      aria-hidden
      data-testid="sidebar-thread-drop-indicator"
      className={cn(
        "pointer-events-none absolute inset-x-2.5 z-30 h-0 border-t-2 border-primary",
        props.edge === "before" ? "top-0" : "bottom-0",
      )}
    />
  );
}

export interface SidebarThreadDragOverlayTransaction {
  readonly sourceThread: EnvironmentThreadShell;
  readonly sourceRect: {
    readonly width: number;
    readonly height: number;
  };
  readonly pointerAnchor: {
    readonly x: number;
    readonly y: number;
  };
}

export function SidebarThreadDragOverlayContent(props: {
  transaction: SidebarThreadDragOverlayTransaction;
  variant: SidebarDndPreviewVariant;
  projectTitle: string | null;
  projectCwd: string | null;
  projectFaviconPath: string | null;
}) {
  const innerRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<Animation | null>(null);
  const geometryRef = useRef<{
    readonly width: number;
    readonly height: number;
  } | null>(null);
  const previewHeight = props.variant === "card" ? 82 : 36;
  const previewWidth = props.transaction.sourceRect.width;
  const left =
    props.transaction.pointerAnchor.x * props.transaction.sourceRect.width -
    props.transaction.pointerAnchor.x * previewWidth;
  const top =
    props.transaction.pointerAnchor.y * props.transaction.sourceRect.height -
    props.transaction.pointerAnchor.y * previewHeight;

  useLayoutEffect(() => {
    const node = innerRef.current;
    if (node === null) return;
    const nextGeometry = { width: previewWidth, height: previewHeight };
    const previousGeometry = geometryRef.current;
    geometryRef.current = nextGeometry;
    if (previousGeometry === null) return;

    const interruptedRect =
      animationRef.current?.playState === "running" ? node.getBoundingClientRect() : null;
    animationRef.current?.cancel();
    const settledRect = node.getBoundingClientRect();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const fromWidth = interruptedRect?.width ?? previousGeometry.width;
    const fromHeight = interruptedRect?.height ?? previousGeometry.height;
    const scaleX = settledRect.width > 0 ? fromWidth / settledRect.width : 1;
    const scaleY = settledRect.height > 0 ? fromHeight / settledRect.height : 1;
    const settledAnchorX = settledRect.left + props.transaction.pointerAnchor.x * settledRect.width;
    const settledAnchorY = settledRect.top + props.transaction.pointerAnchor.y * settledRect.height;
    const translateX =
      interruptedRect === null
        ? 0
        : interruptedRect.left +
          props.transaction.pointerAnchor.x * interruptedRect.width -
          settledAnchorX;
    const translateY =
      interruptedRect === null
        ? 0
        : interruptedRect.top +
          props.transaction.pointerAnchor.y * interruptedRect.height -
          settledAnchorY;
    animationRef.current = node.animate(
      [
        {
          transform: `translate(${translateX}px, ${translateY}px) scale(${scaleX}, ${scaleY})`,
          opacity: 0.88,
        },
        { transform: "translate(0, 0) scale(1, 1)", opacity: 1 },
      ],
      { duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "both" },
    );
  }, [previewHeight, previewWidth, props.transaction.pointerAnchor]);
  useEffect(() => () => animationRef.current?.cancel(), []);

  return (
    <div
      aria-hidden
      className="relative"
      style={{
        width: props.transaction.sourceRect.width,
        height: props.transaction.sourceRect.height,
      }}
    >
      <div
        ref={innerRef}
        className="absolute"
        style={{
          left,
          top,
          width: previewWidth,
          height: previewHeight,
          transformOrigin: `${props.transaction.pointerAnchor.x * 100}% ${props.transaction.pointerAnchor.y * 100}%`,
          willChange: "transform, opacity",
        }}
      >
        <SidebarThreadDragPreview
          thread={props.transaction.sourceThread}
          variant={props.variant}
          projectTitle={props.projectTitle}
          projectCwd={props.projectCwd}
          projectFaviconPath={props.projectFaviconPath}
        />
      </div>
    </div>
  );
}
