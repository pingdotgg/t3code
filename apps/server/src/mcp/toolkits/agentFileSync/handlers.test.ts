import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as AgentFileSync from "../../../agentFileSync/AgentFileSync.ts";
import * as AgentFileSyncLinks from "../../../agentFileSync/AgentFileSyncLinks.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as Handlers from "./handlers.ts";
import { AgentFileSyncToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("sync-tools");
const fixture = (access: "full-access" | "read-only", credentialEnvironmentId = environmentId) => {
  let reads = 0;
  let writes = 0;
  const dependencies = Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: credentialEnvironmentId,
      requestNamespace: "sync-test",
      thread: undefined,
      client: { sessionId: "test", label: "Test", access },
      capabilities: new Set(["orchestration" as const]),
      issuedAt: 0,
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({}),
    Layer.mock(Environment.ServerEnvironment)({
      getDescriptor: Effect.succeed({
        environmentId,
        label: "Test",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.0",
        capabilities: { repositoryIdentity: false },
      }),
    }),
    Layer.mock(AgentFileSync.AgentFileSync)({
      list: () =>
        Effect.sync(() => {
          reads++;
          return { skills: [], instructions: [], warnings: [] };
        }),
    }),
    Layer.mock(AgentFileSyncLinks.AgentFileSyncLinks)({
      manage: (_input, check) =>
        (check ?? Effect.void).pipe(
          Effect.andThen(
            Effect.sync(() => {
              writes++;
            }),
          ),
        ),
    }),
  );
  const layer = McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(
    Layer.provideMerge(dependencies),
  );
  return { layer, counts: () => ({ reads, writes }) };
};

it.effect("read-only clients can inventory files but cannot change sync subscriptions", () =>
  Effect.gen(function* () {
    const f = fixture("read-only");
    yield* Effect.gen(function* () {
      const toolkit = yield* AgentFileSyncToolkit;
      yield* toolkit.handle("t3_agent_files_list", {}).pipe(Stream.unwrap, Stream.runCollect);
      const denied = yield* toolkit
        .handle("t3_agent_files_sync_manage", {
          id: "00000000-0000-0000-0000-000000000000",
          action: "remove",
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(denied.at(-1)?.result).toMatchObject({ code: "capability_denied" });
      expect(f.counts()).toEqual({ reads: 1, writes: 0 });
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect("refuses a different environment's credential before reading files", () =>
  Effect.gen(function* () {
    const f = fixture("full-access", EnvironmentId.make("other-environment"));
    yield* Effect.gen(function* () {
      const toolkit = yield* AgentFileSyncToolkit;
      const denied = yield* toolkit
        .handle("t3_agent_files_list", {})
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(denied.at(-1)?.result).toMatchObject({ code: "capability_denied" });
      expect(f.counts()).toEqual({ reads: 0, writes: 0 });
    }).pipe(Effect.provide(f.layer));
  }),
);
