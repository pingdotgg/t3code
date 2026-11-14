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
    ...(same(save.schedule, opened.schedule) ? {} : { schedule: save.schedule }),
    ...(threadId === opened.threadId ? {} : { threadId }),
    ...(save.threadMode === undefined || save.threadMode === scheduledTaskThreadMode(opened)
      ? {}
      : { threadMode: save.threadMode }),
    ...(same(save.workspaceStrategy, opened.workspaceStrategy)
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
