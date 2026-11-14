import {
  type ScheduledTask,
  type ScheduledTaskUpdateInput,
  type ScheduledTaskUpsertInput,
  scheduledTaskThreadMode,
} from "@t3tools/contracts";

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, entry]) => entry !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => [key, canonical(entry)]),
        )
      : value;

const same = (left: unknown, right: unknown) =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

// Editors send no dedupe as `{}`, no age limit as null, and omit filters they left alone.
const unchangedSchedule = (
  save: ScheduledTaskUpsertInput["schedule"],
  opened: ScheduledTask["schedule"],
): unknown =>
  save.type === "webhook" && opened.type === "webhook"
    ? {
        ...opened,
        maxDeliveryAgeMinutes: opened.maxDeliveryAgeMinutes ?? null,
        dedupe: opened.dedupe ?? {},
        ...(save.filters === undefined ? { filters: undefined } : {}),
      }
    : opened;

// Editors rebuild the workspace from its type, base ref and origin toggle (unset reads as off).
const unchangedWorkspace = (opened: ScheduledTask["workspaceStrategy"]) =>
  opened.type === "worktree"
    ? {
        type: opened.type,
        baseRef: opened.baseRef,
        startFromOrigin: opened.startFromOrigin ?? false,
      }
    : opened.type === "existing_worktree"
      ? { type: opened.type, worktreePath: opened.worktreePath }
      : { type: opened.type };

/**
 * The fields an editor's full save changed from the task it opened, so a save does not
 * overwrite what another client or an agent changed since.
 */
export function scheduledTaskEditPatch(
  opened: ScheduledTask,
  save: ScheduledTaskUpsertInput,
): ScheduledTaskUpdateInput {
  const threadId = save.threadId ?? null;
  return {
    id: opened.id,
    projectId: opened.projectId,
    ...(save.title === opened.title ? {} : { title: save.title }),
    ...(save.prompt === opened.prompt ? {} : { prompt: save.prompt }),
    ...(save.enabled === opened.enabled ? {} : { enabled: save.enabled }),
    ...(same(save.schedule, unchangedSchedule(save.schedule, opened.schedule))
      ? {}
      : { schedule: save.schedule }),
    ...(threadId === opened.threadId ? {} : { threadId }),
    ...(save.threadMode === undefined || save.threadMode === scheduledTaskThreadMode(opened)
      ? {}
      : { threadMode: save.threadMode }),
    ...(same(save.workspaceStrategy, unchangedWorkspace(opened.workspaceStrategy))
      ? {}
      : { workspaceStrategy: save.workspaceStrategy }),
    ...(same(save.modelSelection, opened.modelSelection)
      ? {}
      : { modelSelection: save.modelSelection }),
    ...(save.runtimeMode === opened.runtimeMode ? {} : { runtimeMode: save.runtimeMode }),
    ...(save.interactionMode === opened.interactionMode
      ? {}
      : { interactionMode: save.interactionMode }),
    ...(save.projectId === opened.projectId ? {} : { nextProjectId: save.projectId }),
  };
}
