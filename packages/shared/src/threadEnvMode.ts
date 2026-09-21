import type { ThreadEnvMode } from "@t3tools/contracts";

import { isProjectFileDefaultSettled, resolveProjectFileDefault } from "./projectFileDefaults.ts";

/**
 * Default thread env mode through the shared chain: setting (project over
 * environment) > t3.json > "local". An explicit composer pick outranks all
 * of these; callers apply it before consulting the defaults.
 */
export function resolveDefaultThreadEnvMode(sources: {
  readonly setting: ThreadEnvMode | null | undefined;
  readonly projectFile: ThreadEnvMode | null | undefined;
}): ThreadEnvMode {
  return resolveProjectFileDefault({ ...sources, builtIn: "local" });
}

export function isDefaultThreadEnvModeSettled(sources: {
  readonly explicitMode: ThreadEnvMode | undefined;
  readonly setting: ThreadEnvMode | null | undefined;
  readonly projectFilePending: boolean;
}): boolean {
  return isProjectFileDefaultSettled({
    explicit: sources.explicitMode,
    setting: sources.setting,
    projectFilePending: sources.projectFilePending,
  });
}
