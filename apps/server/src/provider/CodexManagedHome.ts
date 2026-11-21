import type { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";

export const MANAGED_CODEX_MODEL_PROVIDER = "openai_token_sharing";

export const resolveManagedCodexHomeLayout = Effect.fn("resolveManagedCodexHomeLayout")(function* (
  stateDir: string,
  instanceId: ProviderInstanceId,
  config: CodexSettings,
) {
  const path = yield* Path.Path;
  const layout = yield* resolveCodexHomeLayout({
    ...config,
    shadowHomePath:
      config.shadowHomePath.trim() ||
      (instanceId === "codex"
        ? ""
        : path.join(stateDir, "providers", "codex", instanceId, "shadow")),
  });
  return {
    ...layout,
    // Codex resumes a thread on the model provider stored in its rollout, so a thread started
    // on the default `openai` provider cannot continue on the managed one, or the reverse.
    continuationKey: `${layout.continuationKey}:provider:${MANAGED_CODEX_MODEL_PROVIDER}`,
  };
});
