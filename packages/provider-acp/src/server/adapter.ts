// @effect-diagnostics nodeBuiltinImport:off
// ACP provider adapter: wires the session behaviour modules into ProviderAdapterV2.
import * as Effect from "effect/Effect";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { acpSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import { type AcpAdapterV2Options } from "./acpAdapterConfig.ts";
import { makeAcpSessionDeps } from "./acpSessionDeps.ts";
import { createAcpSessionCore } from "./acpSessionCore.ts";
import { createAcpSessionIdentity } from "./acpSessionIdentity.ts";
import { createAcpSessionTerminals } from "./acpSessionTerminals.ts";
import { createAcpTurnProjection } from "./acpTurnProjection.ts";
import { createAcpTextStreaming } from "./acpTextStreaming.ts";
import { createAcpSubagentMessages } from "./acpSubagentMessages.ts";
import { createAcpSubagentTurn } from "./acpSubagentTurn.ts";
import { createAcpNativeChildren } from "./acpNativeChildren.ts";
import { createAcpToolEmission } from "./acpToolEmission.ts";
import { createAcpNotices } from "./acpNotices.ts";
import { createAcpBackgroundContinuation } from "./acpBackgroundContinuation.ts";
import { createAcpAgentTerminalProjection } from "./acpAgentTerminalProjection.ts";
import { createAcpSessionUpdates } from "./acpSessionUpdates.ts";
import { createAcpRuntimeRequests } from "./acpRuntimeRequests.ts";
import { createAcpCarryoverSubagents } from "./acpCarryoverSubagents.ts";
import { createAcpRuntimeWiring } from "./acpRuntimeWiring.ts";
import { createAcpRuntimeHandlers } from "./acpRuntimeHandlers.ts";
import { createAcpRuntimeLifecycle } from "./acpRuntimeLifecycle.ts";
import { createAcpSessionActivation } from "./acpSessionActivation.ts";
import { createAcpTurnSetup } from "./acpTurnSetup.ts";
import { createAcpTurnFinalize } from "./acpTurnFinalize.ts";
import { createAcpTurnPrompt } from "./acpTurnPrompt.ts";
import { createAcpTurnStart } from "./acpTurnStart.ts";
import { createAcpSessionFinalizer } from "./acpSessionFinalizer.ts";
import { createAcpSessionRuntimeHandlers } from "./acpSessionRuntimeHandlers.ts";
import { createAcpSessionRuntimeThreads } from "./acpSessionRuntimeThreads.ts";

export {
  ACP_PROTOCOL,
  acpPerTurnPromptUsage,
  AcpProviderCapabilitiesV2,
} from "./acpAdapterConfig.ts";
export {
  type AcpAdapterV2RuntimeInput,
  type AcpAdapterV2NativeLogging,
  type AcpAdapterV2UserInputRequest,
  type AcpAdapterV2ExtensionContext,
  type AcpAdapterV2Flavor,
  type AcpSubagentSessionEvent,
  type AcpAdapterV2SubagentUpdate,
  type AcpAdapterV2Options,
} from "./acpAdapterConfig.ts";
export { acpScopedNativeId } from "./acpThreadContext.ts";
export { acpToolCallSnippetEdit, acpToolCallDiffPatch } from "./acpToolCallProjection.ts";
export {
  acpPostSettleWakeEvidence,
  acpPostSettleContinuationOfferEvidence,
  acpCompletedTurnShouldTerminalizeTool,
} from "./acpTurnModel.ts";

export const makeAcpAdapterV2 = Effect.fn("makeAcpAdapterV2")(function* (
  options: AcpAdapterV2Options,
) {
  const { flavor } = options;
  const driver = flavor.driver;
  const sessionDeps = yield* makeAcpSessionDeps(options);

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver,
    getCapabilities: Effect.fn("AcpAdapter.getCapabilities")(function () {
      return Effect.succeed(flavor.capabilities);
    }),
    planSelectionTransition: Effect.fn("AcpAdapter.planSelectionTransition")(function (input) {
      return Effect.succeed(acpSelectionTransition(input));
    }),
    openSession: Effect.fn("AcpAdapterV2.openSession")(
      function* (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) {
        const deps = { ...sessionDeps, input };
        const ctx0 = yield* createAcpSessionCore(deps);
        const ctx1 = Object.assign(ctx0, yield* createAcpSessionIdentity(ctx0));
        const ctx2 = Object.assign(ctx1, yield* createAcpSessionTerminals(ctx1));
        const ctx3 = Object.assign(ctx2, yield* createAcpTurnProjection(ctx2));
        const ctx4 = Object.assign(ctx3, yield* createAcpTextStreaming(ctx3));
        const ctx5 = Object.assign(ctx4, createAcpSubagentMessages(ctx4));
        const ctx6 = Object.assign(ctx5, createAcpSubagentTurn(ctx5));
        const ctx7 = Object.assign(ctx6, createAcpNativeChildren(ctx6));
        const ctx8 = Object.assign(ctx7, createAcpToolEmission(ctx7));
        const ctx9 = Object.assign(ctx8, createAcpNotices(ctx8));
        const ctx10 = Object.assign(ctx9, createAcpBackgroundContinuation(ctx9));
        const ctx11 = Object.assign(ctx10, createAcpAgentTerminalProjection(ctx10));
        const ctx12 = Object.assign(ctx11, createAcpSessionUpdates(ctx11));
        const ctx13 = Object.assign(ctx12, createAcpRuntimeRequests(ctx12));
        const ctx14 = Object.assign(ctx13, createAcpCarryoverSubagents(ctx13));
        const ctx15 = Object.assign(ctx14, createAcpRuntimeWiring(ctx14));
        const ctx16 = Object.assign(ctx15, createAcpRuntimeHandlers(ctx15));
        const ctx17 = Object.assign(ctx16, createAcpRuntimeLifecycle(ctx16));
        const ctx18 = Object.assign(ctx17, yield* createAcpSessionActivation(ctx17));
        const ctx19 = Object.assign(ctx18, yield* createAcpTurnSetup(ctx18));
        const ctx20 = Object.assign(ctx19, createAcpTurnFinalize(ctx19));
        const ctx21 = Object.assign(ctx20, createAcpTurnPrompt(ctx20));
        const ctx22 = Object.assign(ctx21, createAcpTurnStart(ctx21));
        const ctx23 = Object.assign(ctx22, yield* createAcpSessionFinalizer(ctx22));

        const sessionRuntime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          ...createAcpSessionRuntimeHandlers(ctx23),
          ...createAcpSessionRuntimeThreads(ctx23),
        };
        return sessionRuntime;
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver,
                providerSessionId: input.providerSessionId,
                ...(flavor.requiresSignIn?.(cause) === true ? { requiresSignIn: true } : {}),
                cause,
              }),
          ),
        ),
    ),
  });
});
