import {
  EnvironmentId,
  type OrchestrationV2ServerCommand,
  ProviderInstanceId,
  RunId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as CommandWatchesHandlers from "./handlers.ts";
import { CommandWatchesToolkit } from "./tools.ts";

const THREAD_ID = ThreadId.make("thread:command-watch-mcp");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const threadCaller: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId: THREAD_ID,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const makeHarness = Effect.fn("makeCommandWatchesHarness")(function* (
  options: {
    readonly runtimeMode?: RuntimeMode;
    readonly subagent?: boolean;
    readonly reject?: string;
  } = {},
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const shell = {
    ...McpToolAccessTestkit.liveThreadShell(
      THREAD_ID,
      options.runtimeMode === undefined ? {} : { runtimeMode: options.runtimeMode },
    ),
    ...(options.subagent === true
      ? {
          lineage: {
            rootThreadId: ThreadId.make("thread:parent"),
            parentThreadId: ThreadId.make("thread:parent"),
            relationshipToParent: "subagent" as const,
          },
        }
      : {}),
  };
  const layerDependencies = Layer.mergeAll(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(shell),
      getThreadRecords: () =>
        Effect.succeed({
          thread: {
            ...McpToolAccessTestkit.idleThreadProjection(shell).thread,
            commandWatches: [],
          },
        }) as never,
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      dispatch: (command) =>
        options.reject === undefined
          ? Ref.update(commands, (recorded) => [...recorded, command]).pipe(
              Effect.as({ sequence: 1, storedEvents: [] }),
            )
          : Effect.fail(
              new Orchestrator.OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
                cause: options.reject,
              }),
            ),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const toolkit = yield* CommandWatchesToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(CommandWatchesHandlers.layer).pipe(
        Layer.provide(layerDependencies),
      ),
    ),
  );
  const call = <Name extends keyof typeof CommandWatchesToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    scope: McpInvocationContext.McpInvocationScope = threadCaller,
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof CommandWatchesToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provide(layerDependencies),
    );
  return { commands, call };
});

describe("command watch toolkit handlers", () => {
  it.effect("starts a watch for the calling run with the default interval", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.call("watch_command", { command: "gh api", label: "Reply" });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.command-watch.start",
          threadId: THREAD_ID,
          callerRunId: RunId.make("run:mcp-test"),
          command: "gh api",
          label: "Reply",
          everyMinutes: 10,
        },
      ]);
    }),
  );

  it.effect("refuses outside Full access, for a subagent, and for an outside client", () =>
    Effect.gen(function* () {
      const supervised = yield* makeHarness({ runtimeMode: "approval-required" });
      expect(
        yield* supervised
          .call("watch_command", { command: "gh api", label: "Reply" })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "OrchestratorMcpFailure", code: "capability_denied" });
      expect(yield* Ref.get(supervised.commands)).toEqual([]);

      const subagent = yield* makeHarness({ subagent: true });
      expect(
        yield* subagent
          .call("watch_command", { command: "gh api", label: "Reply" })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "CommandWatchFailedError" });

      const outside = yield* makeHarness();
      const error = yield* outside
        .call(
          "watch_command",
          { command: "gh api", label: "Reply" },
          {
            ...threadCaller,
            thread: undefined,
            client: { sessionId: "client-1", label: "Client", access: "full-access" },
          },
        )
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "OrchestratorMcpFailure",
        code: "thread_credential_required",
      });
      expect(yield* Ref.get(outside.commands)).toEqual([]);
    }),
  );

  it.effect("tells the agent why the server refused", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ reject: "Thread already watches 5 commands." });
      expect(
        yield* harness
          .call("watch_command", { command: "gh api", label: "Reply" })
          .pipe(Effect.flip),
      ).toMatchObject({
        _tag: "CommandWatchFailedError",
        reason: "Thread already watches 5 commands.",
      });
    }),
  );

  it.effect("stops every watch when no id is given", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.call("unwatch_command", {});
      const [stop] = yield* Ref.get(harness.commands);
      expect(stop).toMatchObject({ type: "thread.command-watch.stop", threadId: THREAD_ID });
      expect(stop).not.toHaveProperty("watchId");
    }),
  );
});
