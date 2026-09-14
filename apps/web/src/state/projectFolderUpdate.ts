import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

const pendingUpdates = new Map<string, Promise<void>>();

/** Keep a checkout's update and preference handoff together across palette replacements. */
export function serializeProjectFolderUpdate<T>(
  ref: { environmentId: EnvironmentId; projectId: ProjectId },
  update: () => Promise<T>,
): Promise<T> {
  const key = JSON.stringify([ref.environmentId, ref.projectId]);
  const result = (pendingUpdates.get(key) ?? Promise.resolve()).then(update);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  pendingUpdates.set(key, settled);
  void settled.then(() => {
    if (pendingUpdates.get(key) === settled) pendingUpdates.delete(key);
  });
  return result;
}
