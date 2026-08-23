import {
  closestCenter,
  getClientRect,
  pointerWithin,
  rectIntersection,
  type CollisionDetection,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import {
  parseSidebarDndSectionId,
  type SidebarDndSection,
  type SidebarThreadDragTransaction,
} from "./Sidebar.dnd.logic";

type CollisionArguments = Parameters<CollisionDetection>[0];

interface SidebarThreadCollisionInput {
  readonly args: CollisionArguments;
  readonly transaction: SidebarThreadDragTransaction;
  readonly sourceThread: EnvironmentThreadShell;
  readonly reorderablePinnedKeys: ReadonlySet<string>;
  readonly viewport: HTMLDivElement | null;
  readonly canDropThreadInSection: (
    thread: EnvironmentThreadShell,
    source: SidebarDndSection,
    destination: SidebarDndSection,
  ) => boolean;
}

function containerSection(input: {
  readonly containerId: UniqueIdentifier;
  readonly sectionByThreadKey: ReadonlyMap<string, SidebarDndSection>;
}): SidebarDndSection | null {
  const boundarySection = parseSidebarDndSectionId(input.containerId);
  if (boundarySection !== null) return boundarySection;
  return typeof input.containerId === "string"
    ? (input.sectionByThreadKey.get(input.containerId) ?? null)
    : null;
}

function visualRect(
  args: CollisionArguments,
  container: CollisionArguments["droppableContainers"][number],
) {
  return container.node.current === null
    ? args.droppableRects.get(container.id)
    : getClientRect(container.node.current);
}

export function detectSidebarThreadCollision(input: SidebarThreadCollisionInput) {
  const { args, transaction } = input;
  const sectionByThreadKey = new Map<string, SidebarDndSection>();
  let entrySection: SidebarDndSection = "pinned";
  for (const entry of transaction.initialEntries) {
    if (entry.kind === "boundary") entrySection = entry.section;
    else sectionByThreadKey.set(entry.id, entrySection);
  }

  if (transaction.sourceSection === "pinned" && args.pointerCoordinates !== null) {
    const pinnedContainers = args.droppableContainers.filter(
      (container) =>
        typeof container.id === "string" &&
        sectionByThreadKey.get(container.id) === "pinned" &&
        input.reorderablePinnedKeys.has(container.id),
    );
    const pinnedRects = pinnedContainers.flatMap((container) => {
      const rect = args.droppableRects.get(container.id);
      return rect === undefined ? [] : [rect];
    });
    const regularBoundary = args.droppableContainers.find(
      (container) => parseSidebarDndSectionId(container.id) === "regular",
    );
    const regularBoundaryTop =
      regularBoundary === undefined
        ? null
        : (args.droppableRects.get(regularBoundary.id)?.top ?? null);
    const pointerOwnsPinned =
      pinnedRects.length > 0 &&
      args.pointerCoordinates.x >= Math.min(...pinnedRects.map((rect) => rect.left)) &&
      args.pointerCoordinates.x <= Math.max(...pinnedRects.map((rect) => rect.right)) &&
      (regularBoundaryTop === null || args.pointerCoordinates.y < regularBoundaryTop);
    if (pointerOwnsPinned) {
      return closestCenter({
        ...args,
        droppableContainers: pinnedContainers,
      });
    }
  }

  const sectionByContainerId = new Map<UniqueIdentifier, SidebarDndSection>();
  const validCandidates = args.droppableContainers.filter((container) => {
    if (container.id === args.active.id) return false;
    const section = containerSection({ containerId: container.id, sectionByThreadKey });
    if (
      section === null ||
      !input.canDropThreadInSection(input.sourceThread, transaction.sourceSection, section)
    ) {
      return false;
    }
    const targetThreadKey =
      parseSidebarDndSectionId(container.id) === null && typeof container.id === "string"
        ? container.id
        : null;
    const valid =
      section !== "pinned" ||
      targetThreadKey === null ||
      input.reorderablePinnedKeys.has(targetThreadKey);
    if (valid) sectionByContainerId.set(container.id, section);
    return valid;
  });

  const visualDroppableRects = new Map(args.droppableRects);
  let visualTop = Number.POSITIVE_INFINITY;
  let visualBottom = Number.NEGATIVE_INFINITY;
  let pointerInsideBoardWidth = false;
  for (const container of validCandidates) {
    const rect = visualRect(args, container);
    if (rect === undefined) continue;
    visualDroppableRects.set(container.id, rect);
    visualTop = Math.min(visualTop, rect.top);
    visualBottom = Math.max(visualBottom, rect.bottom);
    if (
      args.pointerCoordinates !== null &&
      rect.left <= args.pointerCoordinates.x &&
      args.pointerCoordinates.x <= rect.right
    ) {
      pointerInsideBoardWidth = true;
    }
  }

  const snoozedBoundary = validCandidates.find(
    (container) => parseSidebarDndSectionId(container.id) === "snoozed",
  );
  const snoozedBoundaryTop =
    snoozedBoundary === undefined
      ? null
      : (visualDroppableRects.get(snoozedBoundary.id)?.top ?? null);
  const settledBoundary = validCandidates.find(
    (container) => parseSidebarDndSectionId(container.id) === "settled",
  );
  const settledBoundaryTop =
    settledBoundary === undefined
      ? null
      : (visualDroppableRects.get(settledBoundary.id)?.top ?? null);
  const cardCenterY = args.collisionRect.top + args.collisionRect.height / 2;
  const shelfSection =
    settledBoundaryTop !== null && cardCenterY >= settledBoundaryTop
      ? "settled"
      : snoozedBoundaryTop !== null && cardCenterY >= snoozedBoundaryTop
        ? "snoozed"
        : null;
  const collisionCandidates = validCandidates.filter((container) => {
    const section = sectionByContainerId.get(container.id);
    return shelfSection === null
      ? section !== "snoozed" && section !== "settled"
      : section === shelfSection;
  });

  const pointerCollisions = pointerWithin({
    ...args,
    droppableContainers: collisionCandidates,
    droppableRects: visualDroppableRects,
  });
  if (pointerCollisions.length > 0) return pointerCollisions;

  if (args.pointerCoordinates !== null) {
    if (!pointerInsideBoardWidth) return [];
    const { x, y } = args.pointerCoordinates;
    const viewportRect = input.viewport === null ? null : getClientRect(input.viewport);
    const hitAreaTop = viewportRect?.top ?? visualTop;
    const hitAreaBottom = viewportRect?.bottom ?? visualBottom;
    return closestCenter({
      ...args,
      collisionRect:
        y < hitAreaTop || y > hitAreaBottom
          ? args.collisionRect
          : { width: 0, height: 0, top: y, bottom: y, left: x, right: x },
      droppableContainers: collisionCandidates,
      droppableRects: visualDroppableRects,
    });
  }

  return rectIntersection({
    ...args,
    droppableContainers: collisionCandidates,
    droppableRects: visualDroppableRects,
  });
}
