import {
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { createThread, startThreadTurn } from "../operations/commands.ts";
import { subscribe } from "../rpc/client.ts";
import type { GatewayRuntimePort } from "./port.ts";

export interface GatewayEffectRuntime {
  runPromise<A, E>(effect: Effect.Effect<A, E, EnvironmentRegistry | Crypto.Crypto>): Promise<A>;
}

export function createGatewayRuntimePortFromContext(
  context: Context.Context<EnvironmentRegistry | Crypto.Crypto>,
): GatewayRuntimePort {
  return createGatewayRuntimePort({
    runPromise: (effect) => Effect.runPromiseWith(context)(effect),
  });
}

function targetKind(tag: string): string {
  return tag.replace(/ConnectionTarget$/, "").toLowerCase();
}

const shellSnapshot = (environmentId: EnvironmentId) =>
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    return yield* registry.run(
      environmentId,
      subscribe(ORCHESTRATION_WS_METHODS.subscribeShell, {}).pipe(
        Stream.filter((item) => item.kind === "snapshot"),
        Stream.runHead,
        Effect.map(
          (item) => (Option.getOrThrow(item) as { snapshot: OrchestrationShellSnapshot }).snapshot,
        ),
      ),
    );
  });

const threadSnapshot = (environmentId: EnvironmentId, threadId: ThreadId) =>
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    return yield* registry.run(
      environmentId,
      subscribe(ORCHESTRATION_WS_METHODS.subscribeThread, { threadId }).pipe(
        Stream.filter((item) => item.kind === "snapshot"),
        Stream.runHead,
        Effect.map(
          (item) =>
            (Option.getOrThrow(item) as { snapshot: OrchestrationThreadDetailSnapshot }).snapshot,
        ),
      ),
    );
  });

export function createGatewayRuntimePort(runtime: GatewayEffectRuntime): GatewayRuntimePort {
  const run = <A, E>(effect: Effect.Effect<A, E, EnvironmentRegistry | Crypto.Crypto>) =>
    runtime.runPromise(effect);

  return {
    listEnvironments: () =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const entries = yield* SubscriptionRef.get(registry.entries);
          return yield* Effect.forEach([...entries.values()], (entry) =>
            registry.state(entry.target.environmentId).pipe(
              Effect.map((state) => ({
                environmentId: entry.target.environmentId,
                label: entry.target.label,
                targetKind: targetKind(entry.target._tag),
                connectionState: state.phase,
              })),
            ),
          );
        }),
      ),
    getEnvironmentStatus: (rawEnvironmentId) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const environmentId = EnvironmentId.make(rawEnvironmentId);
          const state = yield* registry.state(environmentId);
          return { environmentId, ...state } as Record<string, unknown>;
        }),
      ),
    listProjects: (rawEnvironmentId) =>
      run(shellSnapshot(EnvironmentId.make(rawEnvironmentId))).then((snapshot) => ({
        items: snapshot.projects as ReadonlyArray<Record<string, unknown>>,
        snapshotAt: snapshot.updatedAt,
      })),
    listThreads: (rawEnvironmentId) =>
      run(shellSnapshot(EnvironmentId.make(rawEnvironmentId))).then((snapshot) => ({
        items: snapshot.threads as ReadonlyArray<Record<string, unknown>>,
        snapshotAt: snapshot.updatedAt,
      })),
    getThread: (rawEnvironmentId, rawThreadId) =>
      run(threadSnapshot(EnvironmentId.make(rawEnvironmentId), ThreadId.make(rawThreadId))).then(
        (snapshot) => snapshot.thread as Record<string, unknown>,
      ),
    createThread: (input) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          yield* registry.run(
            EnvironmentId.make(input.environmentId),
            createThread({
              commandId: CommandId.make(input.requestId),
              threadId: ThreadId.make(input.threadId),
              projectId: ProjectId.make(input.projectId),
              title: input.title,
              modelSelection: {
                ...input.modelSelection,
                instanceId: ProviderInstanceId.make(input.modelSelection.instanceId),
              },
              runtimeMode: input.runtimeMode,
              interactionMode: input.interactionMode,
              branch: null,
              worktreePath: null,
            }),
          );
          return {
            requestId: input.requestId,
            commandId: input.requestId,
            status: "accepted" as const,
            threadId: input.threadId,
          };
        }),
      ),
    sendMessage: (input) =>
      run(
        Effect.gen(function* () {
          const environmentId = EnvironmentId.make(input.environmentId);
          const threadId = ThreadId.make(input.threadId);
          const shell = yield* shellSnapshot(environmentId);
          const thread = shell.threads.find((candidate) => candidate.id === threadId);
          if (thread === undefined) throw new Error(`Thread ${input.threadId} was not found.`);
          const registry = yield* EnvironmentRegistry;
          yield* registry.run(
            environmentId,
            startThreadTurn({
              commandId: CommandId.make(input.requestId),
              threadId,
              message: {
                messageId: MessageId.make(input.messageId),
                role: "user",
                text: input.text,
                attachments: [],
              },
              modelSelection: thread.modelSelection,
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
            }),
          );
          return {
            requestId: input.requestId,
            commandId: input.requestId,
            status: "accepted" as const,
            threadId: input.threadId,
            messageId: input.messageId,
          };
        }),
      ),
  };
}
