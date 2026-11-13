import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ServerSettings from "../serverSettings.ts";
import { unavailable } from "./threadAccess.ts";

export function explicitAgentModelFailure(
  model: string | undefined,
  path: string,
  origin?: "explicit" | "inherited" | "unknown",
): OrchestratorMcpFailure | undefined {
  if (
    model !== undefined &&
    model.trim().length > 0 &&
    !["auto", "inherit", "inherit-parent"].includes(model.trim().toLowerCase()) &&
    origin !== "inherited" &&
    origin !== "unknown"
  )
    return undefined;
  return new OrchestratorMcpFailure({
    code: "invalid_request",
    message: `Specify an explicit \`${path}\` from orchestrator_capabilities. This environment requires a model for every new agent-created thread.`,
  });
}

export const assertExplicitAgentModel = Effect.fn("mcp.assertExplicitAgentModel")(function* (
  model: string | undefined,
  path: string,
  origin?: "explicit" | "inherited" | "unknown",
) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const policy = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
  if (!policy.requireExplicitAgentModel) return;
  const failure = explicitAgentModelFailure(model, path, origin);
  if (failure !== undefined) return yield* failure;
});
