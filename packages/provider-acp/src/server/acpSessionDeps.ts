// Runtime services and adapter options handed to an ACP provider session.
import { AgentScope } from "@t3tools/shared/AgentScope";
import { type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import { type ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { acpMcpContext } from "./acpThreadContext.ts";
import { type AcpAdapterV2Options } from "./acpAdapterConfig.ts";

export const makeAcpSessionDeps = Effect.fn("acpSession.deps")(function* (
  options: AcpAdapterV2Options,
) {
  const random = yield* SecureRandom.SecureRandom;
  const fileSystem = yield* FileSystem.FileSystem;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const agentScope = yield* AgentScope;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const host = yield* ProviderHost.ProviderHost;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const { flavor, selfInvocation: self } = options;
  const readMcpContext = (threadId: ThreadId | null) =>
    threadId === null
      ? Effect.succeed(acpMcpContext(undefined, self, flavor.mcpOverHttp))
      : mcpSessions
          .read(threadId)
          .pipe(Effect.map((session) => acpMcpContext(session, self, flavor.mcpOverHttp)));
  const driver = flavor.driver;
  const continuationRequests = options.continuationRequests;
  const postSettleContinuationEnabled =
    flavor.enablePostSettleContinuation === true && continuationRequests !== undefined;

  return {
    options,
    flavor,
    driver,
    self,
    random,
    fileSystem,
    childProcessSpawner,
    agentScope,
    idAllocator,
    host,
    mcpSessions,
    readMcpContext,
    continuationRequests,
    postSettleContinuationEnabled,
  };
});

export type AcpSessionDeps = Effect.Success<ReturnType<typeof makeAcpSessionDeps>> & {
  readonly input: ProviderAdapter.ProviderAdapterV2OpenSessionInput;
};
