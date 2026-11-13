// Extracted from server/adapter.ts.

import {
  type ProviderInstanceId,
  type ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import { findModelConfigOption } from "./runtimeModel.ts";
import { selfInvocationArgs, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import { type AcpAdapterV2Flavor } from "./acpAdapterConfig.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as EffectAcpSchema from "effect-acp/compat";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

export function acpSupportsImagePrompts(input: {
  readonly flavorSupportsImagePrompts?: boolean | undefined;
  readonly negotiatedImage?: boolean | undefined;
}): boolean {
  return input.flavorSupportsImagePrompts === true || input.negotiatedImage === true;
}

export function acpScopedNativeId(instanceId: ProviderInstanceId, nativeId: string): string {
  return `provider-instance:${encodeURIComponent(instanceId)}:${nativeId}`;
}

export function acpProviderItemNativeId(input: {
  readonly instanceId: ProviderInstanceId;
  readonly itemIdentityVersion: 2 | undefined;
  readonly nativeId: string;
}): string {
  return input.itemIdentityVersion === 2
    ? acpScopedNativeId(input.instanceId, input.nativeId)
    : input.nativeId;
}

export const STEER_DELIVERY_BOUND = "2 seconds";

export function forkFromTurnMetaFor(input: {
  readonly driver: ProviderDriverKind;
  readonly flavor: Pick<AcpAdapterV2Flavor, "forkFromTurn">;
  readonly canForkFromTurn: boolean;
  readonly forkInput: ProviderAdapter.ProviderAdapterV2ForkThreadInput;
}): NonNullable<EffectAcpSchema.ForkSessionRequest["_meta"]> | undefined | null {
  const { forkInput } = input;
  if (forkInput.providerTurnId === undefined) return undefined;
  const turns = (forkInput.sourceProviderTurns ?? []).filter(
    (turn) => turn.providerThreadId === forkInput.sourceProviderThread.id,
  );
  const target = turns.find((turn) => turn.id === forkInput.providerTurnId);
  if (target === undefined) return null;
  if (turns.every((turn) => turn.ordinal <= target.ordinal)) return undefined;
  const ref = target.nativeTurnRef;
  if (
    input.flavor.forkFromTurn === undefined ||
    !input.canForkFromTurn ||
    ref === null ||
    ref.driver !== input.driver ||
    ref.strength !== "strong" ||
    ref.nativeId === null
  ) {
    return null;
  }
  return input.flavor.forkFromTurn.forkMeta(ref.nativeId);
}

export function isCompactionMessage(message: ProviderAdapter.ProviderAdapterV2TurnMessage): boolean {
  return message.text.trim() === "/compact" && message.attachments.length === 0;
}

export function negotiatedCapabilities(
  base: OrchestrationV2ProviderCapabilities,
  started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
  modelOptionArrivesLate: boolean,
  forksFromTurn: boolean,
): OrchestrationV2ProviderCapabilities {
  const agent = started.initializeResult.agentCapabilities ?? {};
  const session = agent.sessionCapabilities;
  const setup = started.sessionSetupResult;
  const canSwitchModel =
    modelOptionArrivesLate ||
    findModelConfigOption(setup.configOptions) !== undefined ||
    setup.models != null;
  const canLoad = agent.loadSession === true;
  const canFork = session?.fork != null;
  return {
    ...base,
    sessions: {
      ...base.sessions,
      supportsModelSwitchInSession: canSwitchModel,
    },
    threads: {
      ...base.threads,
      canReadThreadSnapshot: canLoad,
      canForkThread: canFork,
      canForkFromTurn: canFork && forksFromTurn,
    },
    tools: {
      ...base.tools,
      supportsMcpTools: true,
    },
    checkpointing: {
      ...base.checkpointing,
      providerCanReadConversationSnapshot: canLoad,
    },
  };
}

export interface AcpMcpContext {
  readonly servers: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly acpServers: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly httpServers: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly processEnvironment?: NodeJS.ProcessEnv;
  readonly endpoint?: string;
  readonly authorization?: string;
}

export function acpMcpContext(
  session: McpProviderSession.McpProviderSessionConfig | undefined,
  self: SelfInvocation,
  mcpOverHttp: boolean | undefined,
): AcpMcpContext {
  if (session === undefined) {
    return { servers: [], acpServers: [], httpServers: [] };
  }
  // codex-acp 1.2.0 and pi-acp drop injected HTTP servers, so HTTP is opt-in per flavor.
  return {
    servers: [
      {
        name: "t3-code",
        command: self.command,
        args: [...selfInvocationArgs(self, ["acp-mcp-bridge"])],
        env: [
          { name: "ELECTRON_RUN_AS_NODE", value: "1" },
          { name: "T3_ACP_MCP_ENDPOINT", value: session.endpoint },
          { name: "T3_ACP_MCP_AUTHORIZATION", value: session.authorizationHeader },
        ],
      },
    ],
    acpServers: [{ type: "acp", name: "t3-code", serverId: "t3-code" }],
    httpServers:
      mcpOverHttp === true
        ? [
            {
              type: "http",
              name: "t3-code",
              url: session.endpoint,
              headers: [{ name: "Authorization", value: session.authorizationHeader }],
            },
          ]
        : [],
    endpoint: session.endpoint,
    authorization: session.authorizationHeader,
    processEnvironment: {
      T3_ACP_MCP_ENDPOINT: session.endpoint,
      T3_ACP_MCP_AUTHORIZATION: session.authorizationHeader,
      T3_ACP_MCP_NODE: self.command,
      ...(self.entrypoint === undefined ? {} : { T3_ACP_MCP_ENTRYPOINT: self.entrypoint }),
    },
  };
}

export function acpMcpActivation(context: AcpMcpContext) {
  return {
    mcpServers: context.servers,
    acpMcpServers: context.acpServers,
    httpMcpServers: context.httpServers,
  };
}

export function nativeThreadId(
  driver: ProviderDriverKind,
  thread: OrchestrationV2ProviderThread,
): Effect.Effect<string, ProviderAdapter.ProviderAdapterProtocolError> {
  const id = thread.nativeThreadRef?.nativeId;
  if (id === null || id === undefined || id.trim().length === 0) {
    return Effect.fail(
      new ProviderAdapter.ProviderAdapterProtocolError({
        driver,
        detail: `Provider thread ${thread.id} is missing its ACP session id`,
      }),
    );
  }
  return Effect.succeed(id);
}

export function makeProviderThread(input: {
  readonly driver: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly appThreadId: OrchestrationV2ProviderThread["appThreadId"];
  readonly providerSessionId: OrchestrationV2ProviderThread["providerSessionId"];
  readonly nativeThreadId: string;
  readonly ownerNodeId?: OrchestrationV2ProviderThread["ownerNodeId"];
  readonly forkedFrom?: OrchestrationV2ProviderThread["forkedFrom"];
  readonly itemIdentityVersion?: 2;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderThread {
  return {
    id: input.idAllocator.derive.providerThread({
      driver: input.driver,
      providerInstanceId: input.providerInstanceId,
      nativeThreadId: input.nativeThreadId,
    }),
    driver: input.driver,
    providerInstanceId: input.providerInstanceId,
    providerSessionId: input.providerSessionId,
    appThreadId: input.appThreadId,
    ownerNodeId: input.ownerNodeId ?? null,
    nativeThreadRef: {
      driver: input.driver,
      nativeId: input.nativeThreadId,
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: input.forkedFrom ?? null,
    contextUsage: null,
    nativeMetadata:
      input.itemIdentityVersion === undefined
        ? null
        : { itemIdentityVersion: input.itemIdentityVersion },
    createdAt: input.now,
    updatedAt: input.now,
  };
}
