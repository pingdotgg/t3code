import { useSortable, type AnimateLayoutChanges } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";

import {
  createSidebarDndSectionId,
  type SidebarDndPreviewVariant,
  type SidebarDndSection,
} from "../Sidebar.dnd.logic";

export const SIDEBAR_THREAD_DRAG_PRESENTATION_HEIGHT = {
  card: 82,
  slim: 36,
} satisfies Readonly<Record<SidebarDndPreviewVariant, number>>;

const disableLayoutChanges: AnimateLayoutChanges = () => false;

export type SidebarThreadDndRowBag = {
  readonly section: SidebarDndSection;
  readonly listeners: ReturnType<typeof useSortable>["listeners"];
  readonly setNodeRef: (node: HTMLElement | null) => void;
  readonly transform: ReturnType<typeof useSortable>["transform"];
  readonly transition: string | undefined;
  readonly isDragging: boolean;
  readonly isSortable: boolean;
};

export function SidebarThreadDndRow(props: {
  threadKey: string;
  section: SidebarDndSection;
  dragDisabled: boolean;
  disableLayoutAnimation: boolean;
  onNodeChange: (id: string, node: HTMLElement | null) => void;
  children: (bag: SidebarThreadDndRowBag) => ReactNode;
}) {
  const sortable = useSortable({
    id: props.threadKey,
    disabled: { draggable: props.dragDisabled, droppable: false },
    data: { section: props.section },
    ...(props.disableLayoutAnimation ? { animateLayoutChanges: disableLayoutChanges } : {}),
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
    section: props.section,
    listeners: sortable.listeners,
    setNodeRef,
    transform: sortable.transform,
    transition: sortable.transition,
    isDragging: sortable.isDragging,
    isSortable: true,
  });
}

interface SidebarThreadDndBoundaryBag {
  readonly setNodeRef: (node: HTMLElement | null) => void;
  readonly setDroppableNodeRef: (node: HTMLElement | null) => void;
  readonly transform: ReturnType<typeof useSortable>["transform"];
  readonly transition: string | undefined;
  readonly isOver: boolean;
}

export function SidebarThreadDndBoundary(props: {
  section: SidebarDndSection;
  onNodeChange: (id: string, node: HTMLElement | null) => void;
  children: (bag: SidebarThreadDndBoundaryBag) => ReactNode;
}) {
  const id = createSidebarDndSectionId({ section: props.section });
  const sortable = useSortable({
    id,
    disabled: { draggable: true, droppable: false },
    data: { section: props.section },
  });
  const setNodeRef = useCallback(
    (node: HTMLElement | null) => {
      sortable.setDraggableNodeRef(node);
      props.onNodeChange(id, node);
    },
    [id, props.onNodeChange, sortable.setDraggableNodeRef],
  );
  useEffect(
    () => () => {
      props.onNodeChange(id, null);
    },
    [id, props.onNodeChange],
  );
  return props.children({
    setNodeRef,
    setDroppableNodeRef: sortable.setDroppableNodeRef,
    transform: sortable.transform,
    transition: sortable.transition,
    isOver: sortable.isOver,
  });
}

export interface SidebarThreadDragView {
  readonly variant: SidebarDndPreviewVariant;
  readonly pointerAnchor: { readonly x: number; readonly y: number };
}

export function SidebarThreadDndShell(props: {
  threadKey: string;
  variant: SidebarDndPreviewVariant;
  dnd: SidebarThreadDndRowBag | undefined;
  dragView: SidebarThreadDragView | null;
  hidden: boolean;
  inert: boolean;
  onPointerDownCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  children: ReactNode;
}) {
  const { dnd, dragView } = props;
  return (
    <li
      data-thread-item
      data-thread-key={props.threadKey}
      data-sidebar-thread-section={dnd?.section}
      data-dnd-source={props.hidden || dragView !== null || undefined}
      data-dnd-transformed={(dnd?.isSortable === true && dnd.transform !== null) || undefined}
      ref={dnd?.setNodeRef}
      inert={props.inert ? true : undefined}
      style={
        dnd?.isSortable
          ? {
              transform: props.hidden ? undefined : CSS.Translate.toString(dnd.transform),
              transition: props.hidden ? undefined : dnd.transition,
            }
          : undefined
      }
      {...(dnd?.listeners ?? {})}
      onPointerDownCapture={dnd ? props.onPointerDownCapture : undefined}
      className={cn(
        "relative list-none",
        dragView === null &&
          (props.variant === "slim"
            ? "[content-visibility:auto] [contain-intrinsic-size:auto_36px]"
            : "py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_78px]"),
        dnd &&
          "touch-pan-y cursor-grab active:cursor-grabbing [&_[data-thread-row]]:cursor-grab [&_[data-thread-row]]:active:cursor-grabbing",
        dragView !== null && "z-20 cursor-grabbing",
        props.hidden && "opacity-0",
        props.inert && "pointer-events-none",
      )}
    >
      <SidebarThreadDragMorph dragView={dragView}>{props.children}</SidebarThreadDragMorph>
    </li>
  );
}

function SidebarThreadDragMorph(props: {
  dragView: SidebarThreadDragView | null;
  children: ReactNode;
}) {
  const innerRef = useRef<HTMLDivElement>(null);
  const morphAnimationRef = useRef<Animation | null>(null);
  const previousHeightRef = useRef<number | null>(null);
  const previewHeight =
    props.dragView === null
      ? null
      : SIDEBAR_THREAD_DRAG_PRESENTATION_HEIGHT[props.dragView.variant];
  const pointerAnchorX = props.dragView?.pointerAnchor.x ?? null;
  const pointerAnchorY = props.dragView?.pointerAnchor.y ?? null;

  useLayoutEffect(() => {
    const node = innerRef.current;
    if (
      node === null ||
      previewHeight === null ||
      pointerAnchorX === null ||
      pointerAnchorY === null
    ) {
      morphAnimationRef.current?.cancel();
      morphAnimationRef.current = null;
      previousHeightRef.current = null;
      return;
    }
    const previousHeight = previousHeightRef.current;
    previousHeightRef.current = previewHeight;
    if (previousHeight === null) return;

    const interruptedRect =
      morphAnimationRef.current?.playState === "running" ? node.getBoundingClientRect() : null;
    morphAnimationRef.current?.cancel();
    const settledRect = node.getBoundingClientRect();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const fromHeight = interruptedRect?.height ?? previousHeight;
    const scaleY = settledRect.height > 0 ? fromHeight / settledRect.height : 1;
    const settledAnchorY = settledRect.top + pointerAnchorY * settledRect.height;
    const translateY =
      interruptedRect === null
        ? 0
        : interruptedRect.top + pointerAnchorY * interruptedRect.height - settledAnchorY;
    morphAnimationRef.current = node.animate(
      [
        {
          transform: `translateY(${translateY}px) scaleY(${scaleY})`,
          opacity: 0.88,
        },
        { transform: "translateY(0) scaleY(1)", opacity: 1 },
      ],
      { duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "both" },
    );
  }, [pointerAnchorX, pointerAnchorY, previewHeight]);
  useEffect(
    () => () => {
      morphAnimationRef.current?.cancel();
    },
    [],
  );

  if (props.dragView === null || pointerAnchorX === null || pointerAnchorY === null) {
    return props.children;
  }

  return (
    <div
      ref={innerRef}
      className="h-full w-full"
      style={{
        transformOrigin: `${pointerAnchorX * 100}% ${pointerAnchorY * 100}%`,
        willChange: "transform, opacity",
      }}
    >
      {props.children}
    </div>
  );
}
