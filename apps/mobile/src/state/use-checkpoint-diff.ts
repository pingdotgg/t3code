import { createCheckpointDiffManager, type CheckpointDiffTarget } from "@t3tools/client-runtime";

import { appAtomRegistry } from "./atom-registry";
import { getEnvironmentClient } from "./environment-session-registry";

export const checkpointDiffManager = createCheckpointDiffManager({
  getRegistry: () => appAtomRegistry,
  getClient: (environmentId) => getEnvironmentClient(environmentId)?.orchestration ?? null,
});

export function loadCheckpointDiff(
  target: CheckpointDiffTarget,
  options?: { readonly force?: boolean },
) {
  return checkpointDiffManager.load(target, undefined, options);
}
