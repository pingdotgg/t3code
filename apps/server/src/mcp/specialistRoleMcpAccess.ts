import {
  OrchestratorMcpFailure,
  type RuntimeMode,
  type ThreadSpecialistMcpServers,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export const rejectSpecialistStdioMcpBelowFullAccess = (
  limits: { readonly runtimeMode: RuntimeMode },
  mcpServers: ThreadSpecialistMcpServers | undefined,
): Effect.Effect<void, OrchestratorMcpFailure> => {
  if (mcpServers === undefined) return Effect.void;
  const hasStdio = Object.values(mcpServers).some((server) => server.type === "stdio");
  if (!hasStdio || limits.runtimeMode === "full-access") return Effect.void;
  return Effect.fail(
    new OrchestratorMcpFailure({
      code: "runtime_mode_escalation_denied",
      message: "Role MCP stdio servers require a full-access caller ceiling.",
    }),
  );
};
