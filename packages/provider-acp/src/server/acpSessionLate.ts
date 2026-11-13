// Members whose defining module is created after the modules that call them.
// They are late bound so the context type chain stays acyclic.
import type { OrchestrationV2ProviderFailure, OrchestrationV2Subagent } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type { AcpAdapterV2SubagentUpdate } from "./acpAdapterConfig.ts";
import type { AcpNativeChildSession, ActiveAcpTurn } from "./acpTurnModel.ts";
import type { AcpClientTerminals } from "./clientTerminals.ts";

export interface AcpSessionLateBindings {
  clientTerminals: AcpClientTerminals | undefined;
  publishNativeChildStatus: (
    child: AcpNativeChildSession,
    status: AcpAdapterV2SubagentUpdate["status"],
  ) => Effect.Effect<void>;
  cancelPendingRuntimeRequests: () => Effect.Effect<void>;
  finalizeTurn: (
    context: ActiveAcpTurn,
    status: "completed" | "interrupted" | "failed" | "cancelled",
    failure?: OrchestrationV2ProviderFailure,
    options?: { readonly childTurnsContinue?: boolean },
  ) => Effect.Effect<void>;
  offerContinuationRun: (sessionId: string) => Effect.Effect<boolean>;
  updateCarryoverSubagentStatus: (
    nativeIdOrChildSessionId: string,
    status: OrchestrationV2Subagent["status"],
    result?: string | null,
    options?: { readonly project?: boolean },
  ) => Effect.Effect<boolean>;
}
