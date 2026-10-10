import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";

import { makeCloudAdapterV2 } from "./adapter.ts";
import type { CloudBackend, CloudRunInput, CloudRunResult } from "./backends.ts";
import { CloudCliError } from "./cli.ts";

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);
const DRIVER = ProviderDriverKind.make("claudeCloud");
const INSTANCE_ID = ProviderInstanceId.make("claudeCloud");
const THREAD_ID = ThreadId.make("thread-cloud-test");
const TASK = { id: "session_01abc", url: "https://claude.ai/code/session_01abc" };
const modelSelection = { instanceId: INSTANCE_ID, model: "cloud" };
const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/repo",
});

/** A backend whose runs wait until the test settles them. */
const makeControlledBackend = Effect.fnUntraced(function* () {
  const runs = yield* Queue.unbounded<{
    readonly input: CloudRunInput;
    readonly settle: Deferred.Deferred<CloudRunResult, CloudCliError>;
  }>();
  const backend: CloudBackend = {
    label: "Claude Code Cloud",
    run: (input) =>
      Effect.gen(function* () {
        const settle = yield* Deferred.make<CloudRunResult, CloudCliError>();
        yield* Queue.offer(runs, { input, settle });
        return yield* Deferred.await(settle);
      }),
  };
  return { backend, runs };
});

const makeHarness = Effect.fnUntraced(function* (backend: CloudBackend) {
  const adapter = yield* makeCloudAdapterV2({ instanceId: INSTANCE_ID, driver: DRIVER, backend });
  const runtime = yield* adapter.openSession({
    threadId: THREAD_ID,
    providerSessionId: ProviderSessionId.make("session-cloud"),
    modelSelection,
    runtimePolicy,
  });
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  const providerThread = yield* runtime.ensureThread({
    threadId: THREAD_ID,
    modelSelection,
    runtimePolicy,
  });
  const takeEvent = Effect.fnUntraced(function* <
    T extends ProviderAdapter.ProviderAdapterV2Event["type"],
  >(type: T) {
    while (true) {
      const event = yield* Queue.take(events);
      if (event.type === type)
        return event as Extract<ProviderAdapter.ProviderAdapterV2Event, { type: T }>;
    }
  });
  /** The assistant message text of every update until the turn ends, then the terminal. */
  const settleTurn = Effect.fnUntraced(function* () {
    const texts: Array<string> = [];
    while (true) {
      const event = yield* Queue.take(events);
      if (event.type === "message.updated") texts.push(event.message.text);
      if (event.type === "turn.terminal") return { texts, terminal: event };
    }
  });
  return { runtime, providerThread, takeEvent, settleTurn };
});

const turnInput = Effect.fnUntraced(function* (
  providerThread: OrchestrationV2ProviderThread,
  ordinal: number,
  text = "Fix the flaky test",
) {
  const now = yield* DateTime.now;
  return {
    appThread: {
      id: THREAD_ID,
      projectId: ProjectId.make("project-cloud-test"),
      title: "Cloud test",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: INSTANCE_ID,
      modelSelection,
      runtimeMode: runtimePolicy.runtimeMode,
      interactionMode: runtimePolicy.interactionMode,
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId: THREAD_ID,
    runId: RunId.make(`run-${ordinal}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: RunAttemptId.make(`attempt-${ordinal}`),
    rootNodeId: NodeId.make(`root-${ordinal}`),
    providerThread,
    message: {
      messageId: MessageId.make(`message-${ordinal}`),
      text,
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection,
    runtimePolicy,
  } satisfies ProviderAdapter.ProviderAdapterV2TurnInput;
});

describe("cloud adapter", () => {
  it.effect("shows the remote task, then its reply, and continues the session next turn", () =>
    Effect.gen(function* () {
      const { backend, runs } = yield* makeControlledBackend();
      const harness = yield* makeHarness(backend);

      yield* harness.runtime.startTurn(yield* turnInput(harness.providerThread, 1));
      const first = yield* Queue.take(runs);
      assert.strictEqual(first.input.prompt, "Fix the flaky test");
      assert.strictEqual(first.input.cwd, "/repo");
      assert.isUndefined(first.input.session);
      yield* first.input.onTask(TASK);
      yield* Deferred.succeed(first.settle, { task: TASK, text: "Fixed it.", session: TASK.id });
      const settled = yield* harness.settleTurn();

      assert.deepStrictEqual(settled.texts, [
        "Starting in Claude Code Cloud…",
        `Working in Claude Code Cloud: ${TASK.url}`,
        "Fixed it.",
      ]);
      assert.strictEqual(settled.terminal.status, "completed");

      yield* harness.runtime.startTurn(yield* turnInput(harness.providerThread, 2, "Add a test"));
      const second = yield* Queue.take(runs);
      assert.strictEqual(second.input.session, TASK.id);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("fails the turn with the backend's reason", () =>
    Effect.gen(function* () {
      const { backend, runs } = yield* makeControlledBackend();
      const harness = yield* makeHarness(backend);

      yield* harness.runtime.startTurn(yield* turnInput(harness.providerThread, 1));
      const run = yield* Queue.take(runs);
      yield* Deferred.fail(run.settle, new CloudCliError({ detail: "Needs a claude.ai sign-in." }));
      const { terminal } = yield* harness.settleTurn();

      assert.strictEqual(terminal.status, "failed");
      assert.strictEqual(
        terminal.status === "failed" ? terminal.failure.message : undefined,
        "Needs a claude.ai sign-in.",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("Stop ends the turn and points at the task that keeps running", () =>
    Effect.gen(function* () {
      const { backend, runs } = yield* makeControlledBackend();
      const harness = yield* makeHarness(backend);

      yield* harness.runtime.startTurn(yield* turnInput(harness.providerThread, 1));
      const turn = yield* harness.takeEvent("provider_turn.updated");
      const run = yield* Queue.take(runs);
      yield* run.input.onTask(TASK);
      yield* harness.runtime.interruptTurn({
        providerThread: harness.providerThread,
        providerTurnId: turn.providerTurn.id,
      });
      const settled = yield* harness.settleTurn();

      assert.strictEqual(settled.terminal.status, "interrupted");
      assert.include(settled.texts.at(-1), "keeps running in Claude Code Cloud");
      assert.include(settled.texts.at(-1), TASK.url);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("rejects attachments, which never reach the cloud", () =>
    Effect.gen(function* () {
      const { backend } = yield* makeControlledBackend();
      const harness = yield* makeHarness(backend);
      const input = yield* turnInput(harness.providerThread, 1);

      const exit = yield* harness.runtime
        .startTurn({
          ...input,
          message: {
            ...input.message,
            attachments: [
              {
                type: "image",
                id: "attachment-1",
                name: "a.png",
                mimeType: "image/png",
                sizeBytes: 1,
              },
            ],
          },
        })
        .pipe(Effect.exit);

      assert.isTrue(exit._tag === "Failure");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
