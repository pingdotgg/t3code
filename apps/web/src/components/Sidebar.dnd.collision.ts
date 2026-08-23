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
  SIDEBAR_DND_SECTIONS,
  type SidebarDndSection,
  type SidebarThreadDraggingTransaction,
} from "./Sidebar.dnd.logic";

type CollisionArguments = Parameters<CollisionDetection>[0];

interface SidebarThreadCollisionInput {
  readonly args: CollisionArguments;
  readonly transaction: SidebarThreadDraggingTransaction;
  readonly sourceThread: EnvironmentThreadShell;
  readonly reorderablePinnedKeys: ReadonlySet<string>;
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

  const sectionByContainerId = new Map<UniqueIdentifier, SidebarDndSection>();
  const validCandidates = args.droppableContainers.filter((container) => {
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
  const sectionTop = new Map<SidebarDndSection, number>();
  let pointerInsideBoardWidth = false;
  for (const container of validCandidates) {
    const rect = visualRect(args, container);
    if (rect === undefined) continue;
    visualDroppableRects.set(container.id, rect);
    const section = sectionByContainerId.get(container.id);
    if (section !== undefined) {
      sectionTop.set(section, Math.min(sectionTop.get(section) ?? rect.top, rect.top));
    }
    if (
      args.pointerCoordinates !== null &&
      rect.left <= args.pointerCoordinates.x &&
      args.pointerCoordinates.x <= rect.right
    ) {
      pointerInsideBoardWidth = true;
    }
  }

  const sourceCollisionRect =
    args.pointerCoordinates === null
      ? args.collisionRect
      : {
          top:
            args.pointerCoordinates.y - transaction.pointerAnchor.y * transaction.sourceRect.height,
          bottom:
            args.pointerCoordinates.y +
            (1 - transaction.pointerAnchor.y) * transaction.sourceRect.height,
          left:
            args.pointerCoordinates.x - transaction.pointerAnchor.x * transaction.sourceRect.width,
          right:
            args.pointerCoordinates.x +
            (1 - transaction.pointerAnchor.x) * transaction.sourceRect.width,
          width: transaction.sourceRect.width,
          height: transaction.sourceRect.height,
        };
  const cardCenterY = sourceCollisionRect.top + sourceCollisionRect.height / 2;
  let ownedSection: SidebarDndSection | null = null;
  for (const section of SIDEBAR_DND_SECTIONS) {
    const top = sectionTop.get(section);
    if (top === undefined) continue;
    const ownershipY =
      section === "regular" && args.pointerCoordinates !== null
        ? args.pointerCoordinates.y
        : cardCenterY;
    if (ownedSection === null || ownershipY >= top) ownedSection = section;
  }
  const collisionCandidates = validCandidates.filter((container) => {
    const section = sectionByContainerId.get(container.id);
    return section === ownedSection;
  });

  if (transaction.sourceSection === "pinned" && ownedSection === "pinned") {
    if (args.pointerCoordinates !== null && !pointerInsideBoardWidth) return [];
    return closestCenter({
      ...args,
      collisionRect: sourceCollisionRect,
      droppableContainers: collisionCandidates,
    });
  }

  const pointerCollisions = pointerWithin({
    ...args,
    droppableContainers: collisionCandidates,
    droppableRects: visualDroppableRects,
  });
  if (pointerCollisions.length > 0) return pointerCollisions;

  if (args.pointerCoordinates !== null) {
    if (!pointerInsideBoardWidth) return [];
    return closestCenter({
      ...args,
      collisionRect: sourceCollisionRect,
      droppableContainers: collisionCandidates,
      droppableRects: visualDroppableRects,
    });
  }

  return rectIntersection({
    ...args,
    collisionRect: sourceCollisionRect,
    droppableContainers: collisionCandidates,
    droppableRects: visualDroppableRects,
  });
}
