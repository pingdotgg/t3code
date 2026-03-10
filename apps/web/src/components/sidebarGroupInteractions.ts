export function shouldRenderProjectComposeButton(): boolean {
  return false;
}

export function buildProjectGroupCollapseKey(projectId: string, groupId: string): string {
  return `${projectId}\u0000${groupId}`;
}

export function buildThreadGroupCollapsibleKey(
  projectId: string,
  groupId: string,
  orderedGroupIds: ReadonlyArray<string>,
): string {
  return `${projectId}\u0000${groupId}\u0000${orderedGroupIds.join("\u0001")}`;
}

export function buildSidebarInteractionClassName(input: {
  isAnyGroupDragged: boolean;
}): string {
  return input.isAnyGroupDragged ? "select-none" : "";
}

export function setProjectGroupCollapsed(
  collapsedGroupIds: ReadonlySet<string>,
  collapseKey: string,
  open: boolean,
): Set<string> {
  const next = new Set(collapsedGroupIds);
  if (open) {
    next.delete(collapseKey);
  } else {
    next.add(collapseKey);
  }
  return next;
}

export function isProjectGroupOpen(
  collapsedGroupIds: ReadonlySet<string>,
  projectId: string,
  groupId: string,
): boolean {
  return !collapsedGroupIds.has(buildProjectGroupCollapseKey(projectId, groupId));
}

export function expandCollapsedThreadGroupIds(
  collapsedGroupIds: ReadonlySet<string>,
  groupId: string,
): Set<string> {
  const next = new Set(collapsedGroupIds);
  next.delete(groupId);
  return next;
}

export function buildThreadGroupHeaderClassName(input: {
  canDragGroup: boolean;
  isDraggedGroup: boolean;
  isAnyGroupDragged: boolean;
}): string {
  return [
    "group/thread-group flex items-center gap-1.5 rounded-md px-2 py-1 pr-7",
    input.isDraggedGroup ? "bg-accent/50" : "",
    !input.isDraggedGroup && !input.isAnyGroupDragged ? "hover:bg-accent/40" : "",
    input.canDragGroup
      ? input.isAnyGroupDragged
        ? "cursor-grabbing select-none"
        : "cursor-pointer select-none"
      : "cursor-pointer",
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildThreadGroupDropIndicatorClassName(input: {
  isActiveDropTarget: boolean;
}): string {
  return [
    "pointer-events-none absolute inset-x-2 -top-1 h-0.5 rounded-full transition-opacity",
    input.isActiveDropTarget ? "bg-primary opacity-100" : "bg-transparent opacity-0",
  ]
    .filter(Boolean)
    .join(" ");
}

export function hasCrossedThreadGroupDragThreshold(input: {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  thresholdPx: number;
}): boolean {
  const deltaX = Math.abs(input.currentX - input.startX);
  const deltaY = Math.abs(input.currentY - input.startY);
  return deltaX > input.thresholdPx || deltaY > input.thresholdPx;
}

export function shouldIgnoreSidebarDragPointerDown(input: {
  currentTarget: EventTarget;
  target: EventTarget | null;
}): boolean {
  if (
    input.target === null ||
    typeof input.target !== "object" ||
    !("closest" in input.target) ||
    typeof input.target.closest !== "function"
  ) {
    return false;
  }

  const interactiveAncestor = input.target.closest("button, a, input, textarea, select");
  return interactiveAncestor !== null && interactiveAncestor !== input.currentTarget;
}

export function isValidThreadGroupDropTarget(input: {
  draggedGroupId: string;
  targetGroupId: string | null;
  lastGroupId: string | null;
}): boolean {
  if (input.targetGroupId === input.draggedGroupId) {
    return false;
  }
  if (input.targetGroupId === null && input.draggedGroupId === input.lastGroupId) {
    return false;
  }
  return true;
}

export function resolveThreadGroupDropEffect(input: {
  draggedProjectId: string | null;
  targetProjectId: string;
  draggedGroupId: string | null;
  targetGroupId: string | null;
  lastGroupId: string | null;
}): "move" | "none" {
  if (
    input.draggedProjectId === null ||
    input.draggedGroupId === null ||
    input.draggedProjectId !== input.targetProjectId
  ) {
    return "none";
  }

  return isValidThreadGroupDropTarget({
    draggedGroupId: input.draggedGroupId,
    targetGroupId: input.targetGroupId,
    lastGroupId: input.lastGroupId,
  })
    ? "move"
    : "none";
}

export function shouldSnapThreadGroupDropToEnd(input: {
  pointerX: number;
  pointerY: number;
  left: number;
  right: number;
  bottom: number;
  snapStartY: number;
  thresholdPx: number;
}): boolean {
  const withinHorizontalBounds = input.pointerX >= input.left && input.pointerX <= input.right;
  const withinVerticalBounds =
    input.pointerY >= input.snapStartY && input.pointerY <= input.bottom + input.thresholdPx;

  return withinHorizontalBounds && withinVerticalBounds;
}

export function buildThreadGroupDragCursorClassName(input: {
  isDragging: boolean;
}): string {
  return input.isDragging ? "cursor-grabbing" : "";
}

export function buildThreadGroupChevronClassName(input: {
  isOpen: boolean;
}): string {
  return [
    "size-3 shrink-0 text-muted-foreground/50 transition-transform duration-150",
    input.isOpen ? "rotate-90" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildThreadGroupComposeButtonClassName(input: {
  isAnyGroupDragged: boolean;
}): string {
  return [
    "inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/65 opacity-0 transition-colors",
    input.isAnyGroupDragged
      ? "pointer-events-none"
      : "group-hover/thread-group:opacity-100 hover:bg-secondary hover:text-foreground",
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildThreadRowClassName(input: {
  isActive: boolean;
  isAnyGroupDragged: boolean;
}): string {
  return [
    "h-7 w-full translate-x-0 cursor-default justify-start px-2 pl-3 text-left",
    input.isAnyGroupDragged ? "pointer-events-none" : "hover:bg-accent hover:text-foreground",
    input.isActive
      ? "bg-accent/85 text-foreground font-medium ring-1 ring-border/70 dark:bg-accent/55 dark:ring-border/50"
      : "text-muted-foreground",
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildThreadGroupChildrenClassName(input: {
  isOpen: boolean;
  isAnyGroupDragged: boolean;
}): string {
  return [
    "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
    input.isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
    input.isAnyGroupDragged ? "pointer-events-none" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildProjectChildrenClassName(input: {
  isOpen: boolean;
  isAnyProjectDragged: boolean;
}): string {
  return [
    "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
    input.isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
    input.isAnyProjectDragged ? "pointer-events-none" : "",
  ]
    .filter(Boolean)
    .join(" ");
}
