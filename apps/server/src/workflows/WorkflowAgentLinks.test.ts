import { EnvironmentId, OrchestratorMcpFailure } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as WorkflowAgentLinks from "./WorkflowAgentLinks.ts";

const isFailure = Schema.is(OrchestratorMcpFailure);

interface Call {
  readonly environmentId: string;
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly runtimeMode: string;
}

/** The other environment, played by the test: each tool answers from a list, in order. */
const peer = (answers: Record<string, ReadonlyArray<unknown>>, enabled = true) => {
  const calls: Array<Call> = [];
  const left = new Map(Object.entries(answers).map(([tool, list]) => [tool, [...list]]));
  const layer = Layer.merge(
    Layer.succeed(
      PeerMcpClient.PeerMcpClient,
      PeerMcpClient.PeerMcpClient.of({
        call: (input) =>
          Effect.suspend(() => {
            calls.push({
              environmentId: input.environmentId,
              tool: input.tool,
              arguments: input.arguments,
              runtimeMode: input.limits.runtimeMode,
            });
            const answer = left.get(input.tool)?.shift();
            return isFailure(answer) ? Effect.fail(answer) : Effect.succeed(answer as never);
          }),
      }),
    ),
    Layer.mock(PeerLinks.PeerLinks)({ enabled: Effect.succeed(enabled) }),
  );
  return { calls, layer };
};

const input = {
  key: "run-1/write/0",
  origin: { runId: "run-1", workflow: "fix", step: "write" },
  title: "fix: write",
  prompt: "Write the fix.",
  outputSchema: { type: "object" },
  model: undefined,
  project: "/work/app",
  environment: "env-b",
  thread: undefined,
};
const run = (status: string) => ({ recentRuns: [{ runId: "turn-1", status }], items: [] });
const waited = { threadId: "thread-1", runId: "turn-1", status: "idle" };

it.effect("starts a thread there by the project's folder, with the step's key as the request", () =>
  Effect.gen(function* () {
    const there = peer({
      t3_project_list: [
        { projects: [{ id: "p-other", workspaceRoot: "/work/other" }], nextCursor: 1 },
        { projects: [{ id: "p-app", workspaceRoot: "/work/app" }], nextCursor: null },
      ],
      t3_thread_launch: [{ threadId: "thread-1", runId: "turn-1" }],
    });
    const turn = yield* Effect.provide(
      Effect.flatMap(WorkflowAgentLinks.make, (links) =>
        links.start(input, "env-b", "workflow:k", EnvironmentId.make("env-a")),
      ),
      there.layer,
    );
    assert.deepStrictEqual(turn, { threadId: "thread-1", turnId: "turn-1", environment: "env-b" });
    const launch = there.calls.at(-1);
    assert.deepStrictEqual(launch?.arguments, {
      projectId: "p-app",
      title: "fix: write",
      message: "Write the fix.",
      outputSchema: { type: "object" },
      clientRequestId: "workflow:k",
      workflowRun: { environmentId: "env-a", runId: "run-1", workflow: "fix", step: "write" },
    });
    // The link's own access is the ceiling, not a mode narrower than it.
    assert.equal(launch?.runtimeMode, "full-access");
  }),
);

it.effect("registers a folder that is not a project there yet", () =>
  Effect.gen(function* () {
    const there = peer({
      t3_project_list: [{ projects: [], nextCursor: null }],
      t3_project_create: [{ id: "p-new", workspaceRoot: "/work/app" }],
      t3_thread_launch: [{ threadId: "thread-1", runId: "turn-1" }],
    });
    yield* Effect.provide(
      Effect.flatMap(WorkflowAgentLinks.make, (links) =>
        links.start(input, "env-b", "workflow:k", EnvironmentId.make("env-a")),
      ),
      there.layer,
    );
    assert.deepStrictEqual(
      there.calls.map((call) => [call.tool, call.arguments.projectId ?? call.arguments.title]),
      [
        ["t3_project_list", undefined],
        ["t3_project_create", "app"],
        ["t3_thread_launch", "p-new"],
      ],
    );
  }),
);

it.effect("does not start anything while linked environments is off", () =>
  Effect.gen(function* () {
    const there = peer({}, false);
    const error = yield* Effect.provide(
      Effect.flatMap(WorkflowAgentLinks.make, (links) =>
        links.start(input, "env-b", "workflow:k", EnvironmentId.make("env-a")),
      ),
      there.layer,
    ).pipe(Effect.flip);
    assert.match(error.reason, /Linked environments is off/);
    assert.deepStrictEqual(there.calls, []);
  }),
);

it.effect("waits in pieces, rides out a dropped route, and returns the output and reply", () =>
  Effect.gen(function* () {
    const there = peer({
      t3_thread_wait: [
        { ...waited, timedOut: true },
        new OrchestratorMcpFailure({ code: "orchestration_error", message: "unreachable" }),
        { ...waited, timedOut: false, output: { branch: "fix/1" } },
      ],
      t3_thread_read: [
        run("completed"),
        {
          recentRuns: [],
          hasMore: false,
          nextPosition: null,
          items: [
            { type: "assistant_message", runId: "turn-0", text: "earlier", textTruncated: false },
            {
              type: "assistant_message",
              runId: "turn-1",
              itemId: "item-9",
              text: "Done, ",
              textTruncated: true,
              nextTextOffset: 6,
            },
          ],
        },
        { recentRuns: [], items: [{ text: "pushed.", textTruncated: false }] },
      ],
    });
    const result = yield* Effect.provide(
      Effect.flatMap(WorkflowAgentLinks.make, (links) =>
        links.result({ threadId: "thread-1", turnId: "turn-1" }, "env-b"),
      ),
      there.layer,
    ).pipe(Effect.raceFirst(Effect.forever(TestClock.adjust("1 second"))));
    assert.deepStrictEqual(result, {
      ending: "completed",
      detail: "",
      reply: "Done, pushed.",
      output: { branch: "fix/1" },
    });
    assert.equal(there.calls.filter((call) => call.tool === "t3_thread_wait").length, 3);
  }),
);

it.effect("a turn someone stopped there is stopped, and a refused link fails at once", () =>
  Effect.gen(function* () {
    const stopped = peer({
      t3_thread_wait: [{ ...waited, timedOut: false }],
      t3_thread_read: [run("interrupted")],
    });
    const result = yield* Effect.provide(
      Effect.flatMap(WorkflowAgentLinks.make, (links) =>
        links.result({ threadId: "thread-1", turnId: "turn-1" }, "env-b"),
      ),
      stopped.layer,
    );
    assert.deepStrictEqual(result, { ending: "stopped", detail: "interrupted", reply: "" });

    const revoked = peer({
      t3_thread_wait: [
        new OrchestratorMcpFailure({ code: "capability_denied", message: "link revoked" }),
      ],
    });
    const error = yield* Effect.provide(
      Effect.flatMap(WorkflowAgentLinks.make, (links) =>
        links.result({ threadId: "thread-1", turnId: "turn-1" }, "env-b"),
      ),
      revoked.layer,
    ).pipe(Effect.flip);
    assert.match(error.reason, /link revoked/);
    assert.equal(revoked.calls.length, 1);
  }),
);

it.effect("a turn that ended without its result is waited past until a later turn gives it", () =>
  Effect.gen(function* () {
    const there = peer({
      t3_thread_wait: [
        // The turn ended. The agent is waiting to be woken, and has submitted nothing.
        { ...waited, timedOut: false },
        // Quiet for five minutes, in pieces. A turn that woke in between is under way...
        ...Array.from({ length: 6 }, () => ({ ...waited, timedOut: true })),
        // ...so the wait starts over, and that turn submits.
        { ...waited, timedOut: false, output: { head: "abc" } },
      ],
      t3_thread_read: [
        run("completed"),
        { recentRuns: [{ runId: "turn-2", status: "running" }], items: [] },
        { recentRuns: [], hasMore: false, nextPosition: null, items: [] },
      ],
    });
    const result = yield* Effect.provide(
      Effect.flatMap(WorkflowAgentLinks.make, (links) =>
        links.result({ threadId: "thread-1", turnId: "turn-1" }, "env-b", {
          quiet: Duration.minutes(5),
        }),
      ),
      there.layer,
    ).pipe(Effect.raceFirst(Effect.forever(TestClock.adjust("1 second"))));
    assert.deepStrictEqual(result.output, { head: "abc" });
    const waits = there.calls.filter((call) => call.tool === "t3_thread_wait");
    assert.isTrue(waits.slice(1).every((call) => call.arguments.untilOutput === true));
  }),
);

it.effect("a thread that stays quiet gives the turn back without a result", () =>
  Effect.gen(function* () {
    const there = peer({
      t3_thread_wait: [
        { ...waited, timedOut: false },
        ...Array.from({ length: 6 }, () => ({ ...waited, timedOut: true })),
      ],
      t3_thread_read: [
        run("completed"),
        // Nothing has run since the turn the step knows.
        run("completed"),
        { recentRuns: [], hasMore: false, nextPosition: null, items: [] },
      ],
    });
    const result = yield* Effect.provide(
      Effect.flatMap(WorkflowAgentLinks.make, (links) =>
        links.result({ threadId: "thread-1", turnId: "turn-1" }, "env-b", {
          quiet: Duration.minutes(5),
        }),
      ),
      there.layer,
    ).pipe(Effect.raceFirst(Effect.forever(TestClock.adjust("1 second"))));
    assert.deepStrictEqual(result, { ending: "completed", detail: "", reply: "" });
  }),
);
