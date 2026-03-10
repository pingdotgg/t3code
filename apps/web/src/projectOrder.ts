import { type ProjectId } from "@t3tools/contracts";

export function projectOrdersEqual<T extends string>(
  left: readonly T[] | null | undefined,
  right: readonly T[] | null | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.every((id, index) => id === right[index]);
}

export function shouldClearOptimisticProjectOrder<T extends string>(input: {
  optimisticOrder: readonly T[] | null | undefined;
  currentOrder: readonly T[] | null | undefined;
}): boolean {
  if (!input.optimisticOrder) {
    return false;
  }
  return projectOrdersEqual(input.optimisticOrder, input.currentOrder);
}

export function orderProjectsByIds<T extends { id: ProjectId }>(
  projects: readonly T[],
  orderedIds: readonly ProjectId[] | null | undefined,
): T[] {
  if (!orderedIds || orderedIds.length === 0) {
    return [...projects];
  }

  const projectById = new Map(projects.map((project) => [project.id, project] as const));
  const seenProjectIds = new Set<ProjectId>();
  const nextProjects: T[] = [];

  for (const projectId of orderedIds) {
    const project = projectById.get(projectId);
    if (!project || seenProjectIds.has(project.id)) {
      continue;
    }
    nextProjects.push(project);
    seenProjectIds.add(project.id);
  }

  for (const project of projects) {
    if (seenProjectIds.has(project.id)) {
      continue;
    }
    nextProjects.push(project);
  }

  return nextProjects;
}

export function reorderProjectOrder(input: {
  currentOrder: readonly ProjectId[];
  movedProjectId: ProjectId;
  beforeProjectId: ProjectId | null;
}): ProjectId[] {
  if (input.beforeProjectId === input.movedProjectId) {
    return [...input.currentOrder];
  }
  const withoutMoved = input.currentOrder.filter((projectId) => projectId !== input.movedProjectId);

  if (input.beforeProjectId === null) {
    return [...withoutMoved, input.movedProjectId];
  }

  const insertIndex = withoutMoved.indexOf(input.beforeProjectId);
  if (insertIndex === -1) {
    return [input.movedProjectId, ...withoutMoved];
  }

  return [
    ...withoutMoved.slice(0, insertIndex),
    input.movedProjectId,
    ...withoutMoved.slice(insertIndex),
  ];
}
