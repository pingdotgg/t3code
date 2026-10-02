import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ServerConfig } from "../../../config.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../../../provider/Services/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DelegationToolkitHandlersLive } from "./handlers.ts";
import { DelegationToolkit } from "./tools.ts";

const callerThreadId = ThreadId.make("thr_caller");

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("env_1"),
  threadId: callerThreadId,
  providerSessionId: "session-1",
  // Deliberately a non-Copilot provider: this is the parity gap under test.
  providerInstanceId: ProviderInstanceId.make("pi"),
  capabilities: new Set(["terminal"] as const),
  issuedAt: 1,
};

const projectionLayer = Layer.succeed(ProjectionSnapshotQuery, {
  getThreadCheckpointContext: () =>
    Effect.succeed(
      Option.some({ threadId: callerThreadId, workspaceRoot: tmpdir(), worktreePath: null }),
    ),
} as unknown as ProjectionSnapshotQuery["Service"]);

const directoryLayer = Layer.succeed(ProviderSessionDirectory, {
  getBinding: () => Effect.succeed(Option.none()),
} as unknown as ProviderSessionDirectory["Service"]);

const testLayer = Layer.mergeAll(
  projectionLayer,
  directoryLayer,
  ServerConfig.layerTest(tmpdir(), { prefix: "t3-delegation-handlers-" }),
  ServerSettingsService.layerTest(),
  // Supplies `DelegationToolkit` with its handlers bound, so `toolkit.handle`
  // exercises the real handler layer rather than a stub.
  DelegationToolkitHandlersLive,
).pipe(Layer.provideMerge(NodeServices.layer));

interface ToolOutcome {
  readonly result: string;
  readonly isFailure: boolean;
}

/**
 * Every legacy tool shells out to the T3 CLI. `cliCommand` is derived from
 * `process.argv[1]`, so pointing it at a script that echoes its argv lets a
 * test assert the exact command a provider request produced instead of mocking
 * the implementation away.
 */
const withFakeCli = <A, E, R>(use: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "t3-delegation-cli-")));
    const script = join(dir, "fake-cli.mjs");
    yield* Effect.promise(() =>
      writeFile(script, "process.stdout.write(process.argv.slice(2).join('\\n'));\n"),
    );
    const previousArgv = process.argv[1] ?? "";
    process.argv[1] = script;
    return yield* use.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          process.argv[1] = previousArgv;
        }),
      ),
    );
  });

type ToolName = keyof (typeof DelegationToolkit)["tools"];

const invokeTool = (name: ToolName, input: unknown) =>
  Effect.gen(function* () {
    const toolkit = yield* DelegationToolkit;
    const outcomes = yield* Stream.runCollect(
      toolkit.handle(name, input as never).pipe(
        Stream.unwrap,
        Stream.map((outcome) => outcome as unknown as ToolOutcome),
      ),
    );
    const last = outcomes[outcomes.length - 1];
    assert.isDefined(last, `no outcome for ${name}`);
    assert.isFalse(last?.isFailure, `${name} failed: ${last?.result}`);
    return last?.result ?? "";
  }).pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, invocation));

it.layer(testLayer)("DelegationToolkit handlers", (it) => {
  it.effect(
    "routes send_to_thread to the authenticated thread instead of failing as unsupported",
    () =>
      // The regression: a provider that created a child had no tool to message
      // it, so it spawned a second child to deliver the follow-up instead.
      withFakeCli(
        Effect.gen(function* () {
          const output = yield* invokeTool("send_to_thread", {
            thread: "child-thread",
            prompt: "please re-check the proof",
          });
          assert.include(output, "chat");
          assert.include(output, "queue");
          assert.include(output, "child-thread");
          assert.include(output, "please re-check the proof");
          // The calling thread is recorded as provenance, not the destination.
          assert.include(output, callerThreadId);
        }),
      ),
  );

  it.effect("routes assign_to_thread with a stable request id", () =>
    withFakeCli(
      Effect.gen(function* () {
        const output = yield* invokeTool("assign_to_thread", {
          thread: "child-thread",
          prompt: "next step",
          requestId: "req-1",
        });
        assert.include(output, "--request-id");
        assert.include(output, "req-1");
        assert.include(output, callerThreadId);
      }),
    ),
  );

  it.effect("routes set_child_wait and restores on an absent condition", () =>
    withFakeCli(
      Effect.gen(function* () {
        const waitOutput = yield* invokeTool("set_child_wait", {
          condition: { mode: "all", assignments: [{ childThreadId: "c", assignmentId: "a" }] },
        });
        // Pi's extension strips null arguments, so an absent condition must
        // still reach the CLI as an explicit null to restore automatic follow-up.
        const restoreOutput = yield* invokeTool("set_child_wait", {});
        assert.include(waitOutput, "wait");
        assert.include(waitOutput, "all");
        assert.include(restoreOutput, "null");
      }),
    ),
  );

  it.effect("lists the calling thread's linked pull requests", () =>
    withFakeCli(
      Effect.gen(function* () {
        const output = yield* invokeTool("list_thread_pull_requests", {});
        assert.include(output, "list-prs");
        assert.include(output, callerThreadId);
      }),
    ),
  );

  it.effect("advertises a handler for every toolkit tool", () =>
    Effect.gen(function* () {
      const toolkit = yield* DelegationToolkit;
      // Reaching this assertion at all means the handler layer built, which is
      // what `Toolkit.toLayer` proves: it fails construction on a missing tool.
      assert.deepEqual(Object.keys(toolkit.tools).sort(), [
        "assign_to_thread",
        "associate_pull_request",
        "create_isolated_workspace",
        "delegate_work",
        "link_pull_request",
        "list_thread_pull_requests",
        "report_to_parent",
        "send_to_thread",
        "set_child_wait",
        "switch_workspace",
        "unlink_pull_request",
      ]);
    }),
  );
});
