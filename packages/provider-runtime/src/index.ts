// @effect-diagnostics nodeBuiltinImport:off - This package exposes a Promise-based Node host boundary.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClaudeSettings,
  CodexSettings,
  EnvironmentId,
  type ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  type RuntimeMode,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../../apps/server/src/config.ts";
import * as McpProviderSession from "../../../apps/server/src/mcp/McpProviderSession.ts";
import type { ProviderAdapterError } from "../../../apps/server/src/provider/Errors.ts";
import { makeClaudeAdapter } from "../../../apps/server/src/provider/Layers/ClaudeAdapter.ts";
import { makeCodexAdapter } from "../../../apps/server/src/provider/Layers/CodexAdapter.ts";
import type { ProviderAdapterShape } from "../../../apps/server/src/provider/Services/ProviderAdapter.ts";

export type ProviderRuntimeKind = "claude-code" | "codex";

export interface ProviderRuntimeMcpServer {
  readonly authorizationHeader: string;
  readonly endpoint: string;
}

export interface ProviderRuntimeStartInput extends Omit<
  ProviderSessionStartInput,
  "modelSelection" | "provider" | "providerInstanceId" | "runtimeMode"
> {
  readonly mcp?: ProviderRuntimeMcpServer;
  readonly model?: string;
  readonly runtimeMode?: RuntimeMode;
}

export interface CreateProviderRuntimeOptions {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly provider: ProviderRuntimeKind;
  readonly stateDirectory?: string;
  readonly settings?: Record<string, unknown>;
}

export interface ProviderRuntime {
  readonly attachmentsDirectory: string;
  readonly events: AsyncIterable<ProviderRuntimeEvent>;
  close(): Promise<void>;
  hasSession(threadId: ThreadId): Promise<boolean>;
  interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void>;
  listSessions(): Promise<ReadonlyArray<ProviderSession>>;
  respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void>;
  respondToUserInput(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Promise<void>;
  sendTurn(input: ProviderSendTurnInput): Promise<ProviderTurnStartResult>;
  startSession(input: ProviderRuntimeStartInput): Promise<ProviderSession>;
  stopSession(threadId: ThreadId): Promise<void>;
}

const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

function providerIdentity(provider: ProviderRuntimeKind) {
  const driverKind = ProviderDriverKind.make(provider === "claude-code" ? "claudeAgent" : "codex");
  return {
    driverKind,
    instanceId: ProviderInstanceId.make(driverKind),
  };
}

export async function createProviderRuntime(
  options: CreateProviderRuntimeOptions,
): Promise<ProviderRuntime> {
  const cwd = options.cwd ?? process.cwd();
  const ownsStateDirectory = options.stateDirectory === undefined;
  const stateDirectory =
    options.stateDirectory ?? (await mkdtemp(join(tmpdir(), "t3-provider-runtime-")));
  const identity = providerIdentity(options.provider);
  const infrastructure = Layer.merge(
    NodeServices.layer,
    ServerConfig.layerTest(cwd, stateDirectory).pipe(Layer.provide(NodeServices.layer)),
  );
  const normalizeAdapter = (
    adapter: ProviderAdapterShape<ProviderAdapterError>,
  ): ProviderAdapterShape<ProviderAdapterError> => adapter;
  const adapterEffect =
    options.provider === "codex"
      ? makeCodexAdapter(decodeCodexSettings(options.settings ?? {}), {
          instanceId: identity.instanceId,
          environment: options.environment ?? process.env,
        }).pipe(Effect.map(normalizeAdapter), Effect.provide(infrastructure))
      : makeClaudeAdapter(decodeClaudeSettings(options.settings ?? {}), {
          instanceId: identity.instanceId,
          environment: options.environment ?? process.env,
        }).pipe(Effect.map(normalizeAdapter), Effect.provide(infrastructure));
  const AdapterService = Context.Service<Effect.Success<typeof adapterEffect>>(
    "@t3tools/provider-runtime/AdapterService",
  );
  const runtime = ManagedRuntime.make(Layer.effect(AdapterService, adapterEffect));
  let adapter: Effect.Success<typeof adapterEffect>;
  try {
    adapter = await runtime.runPromise(AdapterService);
  } catch (error) {
    await runtime.dispose();
    if (ownsStateDirectory) {
      await rm(stateDirectory, { force: true, recursive: true });
    }
    throw error;
  }
  let closed = false;
  const sessionIds = new Set<ThreadId>();

  const run = <A>(effect: Effect.Effect<A, ProviderAdapterError>): Promise<A> => {
    if (closed) return Promise.reject(new Error("T3 provider runtime is closed."));
    return runtime.runPromise(effect);
  };

  return {
    attachmentsDirectory: join(stateDirectory, "userdata", "attachments"),
    events: adapter.streamEvents.pipe(Stream.toAsyncIterable),
    async close() {
      if (closed) return;
      closed = true;
      for (const threadId of sessionIds) McpProviderSession.clearMcpProviderSession(threadId);
      sessionIds.clear();
      try {
        await runtime.runPromise(adapter.stopAll());
      } finally {
        await runtime.dispose();
        if (ownsStateDirectory) {
          await rm(stateDirectory, { force: true, recursive: true });
        }
      }
    },
    hasSession: (threadId) => run(adapter.hasSession(threadId)),
    interruptTurn: (threadId, turnId) => run(adapter.interruptTurn(threadId, turnId)),
    listSessions: () => run(adapter.listSessions()),
    respondToRequest: (threadId, requestId, decision) =>
      run(adapter.respondToRequest(threadId, requestId, decision)),
    respondToUserInput: (threadId, requestId, answers) =>
      run(adapter.respondToUserInput(threadId, requestId, answers)),
    sendTurn: (input) => run(adapter.sendTurn(input)),
    async startSession(input) {
      const { mcp, model, runtimeMode, ...sessionInput } = input;
      if (mcp) {
        McpProviderSession.setMcpProviderSession({
          authorizationHeader: mcp.authorizationHeader,
          endpoint: mcp.endpoint,
          environmentId: EnvironmentId.make("embedded"),
          providerInstanceId: identity.instanceId,
          providerSessionId: sessionInput.threadId,
          threadId: sessionInput.threadId,
        });
      }
      try {
        const session = await run(
          adapter.startSession({
            ...sessionInput,
            modelSelection: model ? { instanceId: identity.instanceId, model } : undefined,
            provider: identity.driverKind,
            providerInstanceId: identity.instanceId,
            runtimeMode: runtimeMode ?? "full-access",
          }),
        );
        sessionIds.add(sessionInput.threadId);
        return session;
      } catch (error) {
        McpProviderSession.clearMcpProviderSession(sessionInput.threadId);
        throw error;
      }
    },
    async stopSession(threadId) {
      try {
        await run(adapter.stopSession(threadId));
      } finally {
        McpProviderSession.clearMcpProviderSession(threadId);
        sessionIds.delete(threadId);
      }
    },
  };
}

export type {
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderTurnStartResult,
  ProviderUserInputAnswers,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
