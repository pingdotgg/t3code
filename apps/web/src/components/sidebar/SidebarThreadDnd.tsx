import { useSortable, type AnimateLayoutChanges } from "@dnd-kit/sortable";
import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

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

export interface SidebarThreadDndBoundaryBag {
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

interface SidebarThreadDragViewBase {
  readonly variant: SidebarDndPreviewVariant;
  readonly flowPlaceholderHeight: number;
  readonly sourceRect: {
    readonly top: number;
    readonly left: number;
    readonly width: number;
    readonly height: number;
  };
  readonly translation: {
    readonly x: number;
    readonly y: number;
  };
  readonly scrollDeltaY: number;
  readonly pointerAnchor: {
    readonly x: number;
    readonly y: number;
  };
}

export type SidebarThreadDragView = SidebarThreadDragViewBase &
  (
    | { readonly kind: "dragging" }
    | { readonly kind: "holding" }
    | {
        readonly kind: "dropping";
        readonly targetNode: HTMLElement | null;
        readonly onAnimationEnd: () => void;
      }
  );

export function SidebarThreadDragMorph(props: {
  dragView: SidebarThreadDragView | null;
  children: ReactNode;
}) {
  const innerRef = useRef<HTMLDivElement>(null);
  const morphAnimationRef = useRef<Animation | null>(null);
  const dropAnimationRef = useRef<Animation | null>(null);
  const geometryRef = useRef<{
    readonly width: number;
    readonly height: number;
  } | null>(null);
  const previewHeight =
    props.dragView === null
      ? null
      : SIDEBAR_THREAD_DRAG_PRESENTATION_HEIGHT[props.dragView.variant];
  const previewWidth = props.dragView?.sourceRect.width ?? null;
  const pointerAnchorX = props.dragView?.pointerAnchor.x ?? null;
  const pointerAnchorY = props.dragView?.pointerAnchor.y ?? null;

  useLayoutEffect(() => {
    const node = innerRef.current;
    if (
      node === null ||
      previewHeight === null ||
      previewWidth === null ||
      pointerAnchorX === null ||
      pointerAnchorY === null
    ) {
      morphAnimationRef.current?.cancel();
      morphAnimationRef.current = null;
      geometryRef.current = null;
      return;
    }
    const nextGeometry = { width: previewWidth, height: previewHeight };
    const previousGeometry = geometryRef.current;
    geometryRef.current = nextGeometry;
    if (previousGeometry === null) return;

    const interruptedRect =
      morphAnimationRef.current?.playState === "running" ? node.getBoundingClientRect() : null;
    morphAnimationRef.current?.cancel();
    const settledRect = node.getBoundingClientRect();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const fromWidth = interruptedRect?.width ?? previousGeometry.width;
    const fromHeight = interruptedRect?.height ?? previousGeometry.height;
    const scaleX = settledRect.width > 0 ? fromWidth / settledRect.width : 1;
    const scaleY = settledRect.height > 0 ? fromHeight / settledRect.height : 1;
    const settledAnchorX = settledRect.left + pointerAnchorX * settledRect.width;
    const settledAnchorY = settledRect.top + pointerAnchorY * settledRect.height;
    const translateX =
      interruptedRect === null
        ? 0
        : interruptedRect.left + pointerAnchorX * interruptedRect.width - settledAnchorX;
    const translateY =
      interruptedRect === null
        ? 0
        : interruptedRect.top + pointerAnchorY * interruptedRect.height - settledAnchorY;
    morphAnimationRef.current = node.animate(
      [
        {
          transform: `translate(${translateX}px, ${translateY}px) scale(${scaleX}, ${scaleY})`,
          opacity: 0.88,
        },
        { transform: "translate(0, 0) scale(1, 1)", opacity: 1 },
      ],
      { duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "both" },
    );
  }, [pointerAnchorX, pointerAnchorY, previewHeight, previewWidth]);
  const dragKind = props.dragView?.kind ?? null;
  const dropTargetNode = props.dragView?.kind === "dropping" ? props.dragView.targetNode : null;
  const onDropAnimationEnd =
    props.dragView?.kind === "dropping" ? props.dragView.onAnimationEnd : null;

  useLayoutEffect(() => {
    if (dragKind !== "dropping" || onDropAnimationEnd === null) return;
    const node = innerRef.current;
    if (node === null || dropTargetNode === null) {
      onDropAnimationEnd();
      return;
    }

    const fromRect = node.getBoundingClientRect();
    morphAnimationRef.current?.cancel();
    morphAnimationRef.current = null;
    const settledRect = node.getBoundingClientRect();
    const targetRect = dropTargetNode.getBoundingClientRect();
    if (
      settledRect.width === 0 ||
      settledRect.height === 0 ||
      targetRect.width === 0 ||
      targetRect.height === 0 ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      onDropAnimationEnd();
      return;
    }

    const transform = (rect: Pick<DOMRect, "left" | "top" | "width" | "height">) =>
      `translate(${rect.left - settledRect.left}px, ${rect.top - settledRect.top}px) scale(${rect.width / settledRect.width}, ${rect.height / settledRect.height})`;
    const animation = node.animate(
      [
        { transformOrigin: "0 0", transform: transform(fromRect) },
        { transformOrigin: "0 0", transform: transform(targetRect) },
      ],
      { duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "both" },
    );
    dropAnimationRef.current = animation;
    void animation.finished.then(
      () => {
        if (dropAnimationRef.current !== animation) return;
        dropAnimationRef.current = null;
        onDropAnimationEnd();
      },
      () => undefined,
    );
    return () => {
      if (dropAnimationRef.current !== animation) return;
      dropAnimationRef.current = null;
      animation.cancel();
    };
  }, [dragKind, dropTargetNode, onDropAnimationEnd]);
  useEffect(
    () => () => {
      morphAnimationRef.current?.cancel();
      dropAnimationRef.current?.cancel();
    },
    [],
  );

  if (
    props.dragView === null ||
    previewHeight === null ||
    previewWidth === null ||
    pointerAnchorX === null ||
    pointerAnchorY === null
  ) {
    return props.children;
  }

  const left = pointerAnchorX * props.dragView.sourceRect.width - pointerAnchorX * previewWidth;
  const top = pointerAnchorY * props.dragView.sourceRect.height - pointerAnchorY * previewHeight;

  return (
    <div
      className="pointer-events-none fixed z-20"
      style={{
        top: props.dragView.sourceRect.top,
        left: props.dragView.sourceRect.left,
        width: props.dragView.sourceRect.width,
        height: props.dragView.sourceRect.height,
        transform: `translate3d(${props.dragView.translation.x}px, ${props.dragView.translation.y - props.dragView.scrollDeltaY}px, 0)`,
        willChange: "transform",
      }}
    >
      <div
        ref={innerRef}
        className={props.dragView.variant === "card" ? "absolute py-0.5" : "absolute"}
        style={{
          left,
          top,
          width: previewWidth,
          height: previewHeight,
          transformOrigin: `${pointerAnchorX * 100}% ${pointerAnchorY * 100}%`,
          willChange: "transform, opacity",
        }}
      >
        {props.children}
      </div>
    </div>
  );
}
