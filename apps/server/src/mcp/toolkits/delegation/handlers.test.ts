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

const requestActivity = (
  kind: string,
  requestId: string,
  payload: Record<string, unknown> = {},
) => ({
  id: `${kind}-${requestId}`,
  kind,
  tone: "approval",
  summary: kind,
  payload: { requestId, ...payload },
  turnId: null,
  createdAt: "2026-09-09T00:00:00.000Z",
});

// A child of the caller with one pending approval, one pending question, and
// one already-answered approval; plus a thread the caller does not own.
const threadDetails = new Map<string, unknown>([
  [
    "child-thread",
    {
      id: "child-thread",
      title: "Child",
      parentThreadId: callerThreadId,
      activities: [
        requestActivity("approval.requested", "approval-1"),
        requestActivity("user-input.requested", "input-1"),
        requestActivity("approval.requested", "approval-done"),
        requestActivity("approval.resolved", "approval-done"),
      ],
    },
  ],
  [
    "stranger-thread",
    {
      id: "stranger-thread",
      title: "Stranger",
      parentThreadId: ThreadId.make("someone-else"),
      activities: [requestActivity("approval.requested", "approval-2")],
    },
  ],
]);

const projectionLayer = Layer.succeed(ProjectionSnapshotQuery, {
  getThreadCheckpointContext: () =>
    Effect.succeed(
      Option.some({ threadId: callerThreadId, workspaceRoot: tmpdir(), worktreePath: null }),
    ),
  getThreadDetailById: (threadId: string) =>
    Effect.succeed(Option.fromNullishOr(threadDetails.get(threadId))),
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
 * Every legacy tool shells out to the T3 CLI. Resolved through the same
 * `T3_MCP_CLI_COMMAND` override the stdio server honors, so pointing that at a
 * script which echoes its argv lets a test assert the exact command a provider
 * request produced instead of mocking the implementation away.
 */
const withFakeCli = <A, E, R>(use: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "t3-delegation-cli-")));
    const script = join(dir, "fake-cli.mjs");
    yield* Effect.promise(() =>
      writeFile(script, "process.stdout.write(process.argv.slice(2).join('\\n'));\n"),
    );
    const previousCommand = process.env.T3_MCP_CLI_COMMAND;
    const previousPrefix = process.env.T3_MCP_CLI_ARGS_PREFIX;
    // `T3_MCP_CLI_COMMAND` names the executable; `T3_MCP_CLI_ARGS_PREFIX` is the
    // JSON argv prefix that reaches it. Setting both mirrors how a deployment
    // wraps or relocates the CLI.
    process.env.T3_MCP_CLI_COMMAND = process.execPath;
    process.env.T3_MCP_CLI_ARGS_PREFIX = JSON.stringify([script]);
    return yield* use.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previousCommand === undefined) {
            delete process.env.T3_MCP_CLI_COMMAND;
          } else {
            process.env.T3_MCP_CLI_COMMAND = previousCommand;
          }
          if (previousPrefix === undefined) {
            delete process.env.T3_MCP_CLI_ARGS_PREFIX;
          } else {
            process.env.T3_MCP_CLI_ARGS_PREFIX = previousPrefix;
          }
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

  it.effect("lets a parent approve its child's pending approval request", () =>
    withFakeCli(
      Effect.gen(function* () {
        const output = yield* invokeTool("respond_to_child_request", {
          thread: "child-thread",
          requestId: "approval-1",
          decision: "accept",
        });
        assert.deepEqual(output.split("\n").slice(0, 5), [
          "approval",
          "respond",
          "child-thread",
          "approval-1",
          "--decision",
        ]);
        assert.include(output, "accept");
      }),
    ),
  );

  it.effect("lets a parent answer its child's pending question", () =>
    withFakeCli(
      Effect.gen(function* () {
        const output = yield* invokeTool("respond_to_child_request", {
          thread: "child-thread",
          requestId: "input-1",
          answers: { policy: "Deny" },
        });
        assert.deepEqual(output.split("\n").slice(0, 4), [
          "input",
          "respond",
          "child-thread",
          "input-1",
        ]);
        assert.include(output, JSON.stringify({ policy: "Deny" }));
      }),
    ),
  );

  it.effect("refuses requests that are not the caller's to answer", () =>
    withFakeCli(
      Effect.gen(function* () {
        const cases = [
          [
            { thread: "stranger-thread", requestId: "approval-2", decision: "accept" },
            "not a child",
          ],
          [
            { thread: "child-thread", requestId: "approval-done", decision: "accept" },
            "no pending",
          ],
          [{ thread: "child-thread", requestId: "approval-1", answers: { a: "b" } }, "decision"],
          [{ thread: "child-thread", requestId: "input-1", decision: "accept" }, "answers"],
        ] as const;
        for (const [input, message] of cases) {
          const error = yield* Effect.flip(invokeTool("respond_to_child_request", input));
          assert.include(String(error), message);
        }
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
        "respond_to_child_request",
        "send_to_thread",
        "set_child_wait",
        "switch_workspace",
        "unlink_pull_request",
      ]);
    }),
  );
});
