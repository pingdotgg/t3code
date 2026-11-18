import { scopeProjectKey, type ScopedProjectRef } from "@t3tools/contracts";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { projectEnvironment, regeneratingProjectIconKeysAtom } from "../state/projects";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

export function useRegenerateProjectIcon() {
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  return async (ref: ScopedProjectRef) => {
    const key = scopeProjectKey(ref);
    const prev = appAtomRegistry.get(regeneratingProjectIconKeysAtom);
    if (prev.has(key)) return;

    const next = new Set(prev);
    next.add(key);
    appAtomRegistry.set(regeneratingProjectIconKeysAtom, next);

    try {
      const result = await updateProject({
        environmentId: ref.environmentId,
        input: { projectId: ref.projectId, regenerateIcon: true },
      });
      if (result._tag === "Failure") {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to regenerate project icon",
            description:
              result.cause instanceof Error
                ? result.cause.message
                : "Could not generate project icon.",
          }),
        );
      } else {
        toastManager.add(
          stackedThreadToast({
            type: "info",
            title: "Project icon updated",
            description: "The icon was successfully regenerated.",
          }),
        );
      }
      return result;
    } finally {
      const current = appAtomRegistry.get(regeneratingProjectIconKeysAtom);
      const cleaned = new Set(current);
      cleaned.delete(key);
      appAtomRegistry.set(regeneratingProjectIconKeysAtom, cleaned);
    }
  };
}
