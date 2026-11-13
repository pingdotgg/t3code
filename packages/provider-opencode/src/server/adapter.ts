import type {
  Event as OpenCodeEvent,
  Message as OpenCodeMessage,
  Part as OpenCodePart,
  PermissionRequest,
  PermissionRuleset,
  QuestionRequest,
  Session as OpenCodeSession,
  Todo as OpenCodeTodo,
  ToolPart,
} from "@opencode-ai/sdk/v2";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { causeErrorTag } from "@t3tools/shared/observability";
import {
  defaultInstanceIdForDriver,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanStep,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type PlanId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRequestKind,
  type ProviderSessionId,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import { OpenCodeSettings } from "../settings.ts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import {
  structuralProtocolMethod,
  summarizeNativeProtocolPayload,
} from "@t3tools/provider-core/server/nativeProtocolLogging";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { t3OrchestrationSystemPrompt } from "@t3tools/provider-core/server/orchestrationInstructions";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import { readableProviderErrorMessage } from "./providerErrorMessage.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import { providerMessageTextWithAttachmentPaths } from "@t3tools/provider-core/server/attachmentPrompt";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import {
  makeSubagentChildThread,
  subagentThreadTitle,
} from "@t3tools/provider-core/server/subagentProjection";
import { openCodeCommandFailed, openCodeToolTurnItem } from "./toolItems.ts";

import { OPENCODE_PROVIDER } from "./opencode/provider.ts";
import { OpenCodeProviderCapabilitiesV2 } from "./opencode/capabilities.ts";
import type { OpenCodeAdapterV2Options } from "./opencode/types.ts";

const DEFAULT_OPENCODE_SETTINGS = Schema.decodeSync(OpenCodeSettings)({});

import { createOpenCodeSessionState } from "./opencode/session/base.ts";
import { makeItems } from "./opencode/session/items.ts";
import { makeSubagents } from "./opencode/session/subagents.ts";
import { makeToolParts } from "./opencode/session/toolParts.ts";
import { makeRequests } from "./opencode/session/requests.ts";
import { makeTurns } from "./opencode/session/turns.ts";
import { makeEvents } from "./opencode/session/events.ts";
import { makeSubscription } from "./opencode/session/subscription.ts";
import { makeThreads } from "./opencode/session/threads.ts";
import { makeRuntimeCore } from "./opencode/session/runtime.ts";
import { makeRuntimeHistory } from "./opencode/session/runtime-history.ts";

export {
  OPENCODE_DEFAULT_INSTANCE_ID,
  OPENCODE_PROVIDER,
  OPENCODE_SDK_PROTOCOL,
  makeOpenCodeMessageId,
} from "./opencode/provider.ts";
export {
  advanceOpenCodePromptAdmission,
  cancelOpenCodePromptAdmission,
  reconcileOpenCodePromptAdmissionStatus,
} from "./opencode/admission.ts";
export {
  openCodeChildPermissionRules,
  openCodePermissionRequestKind,
  openCodePermissionRules,
} from "./opencode/permissions.ts";
export { openCodeBoundaryAfterProviderTurn } from "./opencode/tools.ts";
export { makeOpenCodeProtocolLogger } from "./opencode/protocol.ts";

export const makeOpenCodeAdapterV2 = Effect.fn("makeOpenCodeAdapterV2")(function* (
  options: OpenCodeAdapterV2Options,
) {
  const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const host = yield* ProviderHost.ProviderHost;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const messageIdClock = yield* Ref.make({ epochMillis: -1, counter: 0 });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: OPENCODE_PROVIDER,
    getCapabilities: Effect.fn("OpencodeAdapter.getCapabilities")(function () {
      return Effect.succeed(OpenCodeProviderCapabilitiesV2);
    }),
    planSelectionTransition: Effect.fn("OpencodeAdapter.planSelectionTransition")(function () {
      return Effect.succeed(turnScopedSelectionTransition());
    }),
    openSession: Effect.fn("OpenCodeAdapterV2.openSession")(
      function* (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) {
        const scope = yield* Effect.scope;
        const cwd = input.runtimePolicy.cwd ?? host.paths.cwd;
        const connection = yield* runtime.connectToOpenCodeServer({
          binaryPath: options.settings.binaryPath,
          directory: cwd,
          serverUrl: options.settings.serverUrl,
          ...(options.settings.serverPassword
            ? { serverPassword: options.settings.serverPassword }
            : {}),
          environment: options.environment,
        });
        const client = runtime.createOpenCodeSdkClient({
          baseUrl: connection.url,
          directory: cwd,
          ...(connection.serverPassword !== undefined
            ? { serverPassword: connection.serverPassword }
            : {}),
        });

        const mcpSession = yield* mcpSessions.read(input.threadId);
        const hasT3Mcp = mcpSession !== undefined && !connection.external;
        const orchestrationSystemPrompt = t3OrchestrationSystemPrompt(
          hasT3Mcp,
          mcpSession?.capabilities?.has("device") === true,
        );
        if (hasT3Mcp) {
          yield* OpenCodeRuntime.runOpenCodeSdk("mcp.add", () =>
            client.mcp.add({
              name: "t3-code",
              config: {
                type: "remote",
                url: mcpSession.endpoint,
                headers: { Authorization: mcpSession.authorizationHeader },
                oauth: false,
              },
            }),
          );
        }


        const state = yield* createOpenCodeSessionState({
          options,
          input,
          connection,
          client,
          cwd,
          scope,
          mcpSession,
          hasT3Mcp,
          orchestrationSystemPrompt,
          runtime,
          idAllocator,
          host,
          mcpSessions,
          messageIdClock,
        });

        // Installed in dependency order; each layer may call every layer above it.
        const withItems = Object.assign(state, makeItems(state));
        const withSubagents = Object.assign(withItems, makeSubagents(withItems));
        const withToolParts = Object.assign(withSubagents, makeToolParts(withSubagents));
        const withRequests = Object.assign(withToolParts, makeRequests(withToolParts));
        const withTurns = Object.assign(withRequests, makeTurns(withRequests));
        const withEvents = Object.assign(withTurns, makeEvents(withTurns));
        const withThreads = Object.assign(withEvents, makeThreads(withEvents));
        const withSubscription = Object.assign(withThreads, makeSubscription(withThreads));

        // Subscribed before any prompt is sent, so no native event of theirs is missed.
        yield* withSubscription.startSubscription();

        const runtimeSession: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          ...makeRuntimeCore(withSubscription),
          ...makeRuntimeHistory(withSubscription),
          // The session entity is replaced on every status change, so it must stay
          // a live accessor instead of a value copied out of the spread above.
          get providerSession() {
            return state.mutable.sessionEntity;
          },
        };
        return runtimeSession;
      },

      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: OPENCODE_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        ),
    ),
  });
});

export type OpenCodeAdapterV2DriverEnv =
  | OpenCodeRuntime.OpenCodeRuntime
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const OpenCodeAdapterV2Driver: ProviderAdapterDriver<
  OpenCodeSettings,
  OpenCodeAdapterV2DriverEnv
> = {
  driverKind: OPENCODE_PROVIDER,
  configSchema: OpenCodeSettings,
  defaultConfig: (): OpenCodeSettings => DEFAULT_OPENCODE_SETTINGS,
  create: Effect.fn("OpenCodeAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<OpenCodeSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      return yield* makeOpenCodeAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        ...(providerEventLoggers.native === undefined
          ? {}
          : { nativeEventLogger: providerEventLoggers.native }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: OPENCODE_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create OpenCode v2 adapter.",
              cause,
            }),
        ),
      ),
  ),
};
