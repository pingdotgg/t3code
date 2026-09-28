import type { ServerProvider } from "@t3tools/contracts";

/**
 * A provider as a cloud thread sees it. An instance that can run in the cloud
 * offers its cloud models and is ready whenever cloud is set up, whatever its
 * local CLI's state. Instances without cloud support are unchanged.
 */
export function cloudProviderSnapshot(snapshot: ServerProvider): ServerProvider {
  const { cloud, message: _localMessage, ...rest } = snapshot;
  if (!cloud) return snapshot;
  return {
    ...rest,
    cloud,
    installed: true,
    status: cloud.available ? "ready" : "error",
    auth: { status: cloud.available ? "authenticated" : "unauthenticated" },
    ...(cloud.message ? { message: cloud.message } : {}),
    models: cloud.models,
    // A cloud agent keeps the model it was created with, and has no local commands.
    requiresNewThreadForModelChange: true,
    slashCommands: [],
    skills: [],
  };
}
