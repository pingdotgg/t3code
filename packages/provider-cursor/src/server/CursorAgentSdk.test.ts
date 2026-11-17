import type { ListRunsOptions } from "@cursor/sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import { vi } from "vite-plus/test";

import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import * as CursorSdk from "./CursorSdk.ts";

const cursorSdkMock = vi.hoisted(() => {
  const closeExecutionOrder: Array<string> = [];
  const runOperations: Array<string> = [];
  let agentCloseFailure: unknown;
  // The local store lists runs oldest first, like the real SDK.
  let storedRuns: Array<{ readonly id: string; readonly status: string }> = [];
  const runWait = vi.fn(async () => ({
    id: "run-cursor-agent-sdk-test",
    requestId: "request-cursor-agent-sdk-test",
    status: "finished",
    result: "ok",
    model: { id: "default" },
    durationMs: 1,
  }));
  const runCancel = vi.fn(async () => {});
  const runSteer = vi.fn(async () => "complete_delivered" as const);
  const agentClose = vi.fn(() => {
    closeExecutionOrder.push("sdk:agent.close");
    if (agentCloseFailure !== undefined) {
      throw agentCloseFailure;
    }
  });
  const send = vi.fn(
    async (
      _message: unknown,
      options: { readonly onDelta?: (input: { readonly update: unknown }) => Promise<void> },
    ) => {
      runOperations.push("run.start");
      if (storedRuns.some((run) => run.status === "running")) {
        throw new Error("Agent agent-cursor-agent-sdk-test already has active run");
      }
      await options.onDelta?.({
        update: {
          type: "assistant-message-chunk",
          text: "hello",
        },
      });
      return {
        id: "run-cursor-agent-sdk-test",
        agentId: "agent-cursor-agent-sdk-test",
        wait: runWait,
        cancel: runCancel,
        steer: runSteer as typeof runSteer | undefined,
      };
    },
  );
  const create = vi.fn(async () => ({
    agentId: "agent-cursor-agent-sdk-test",
    send,
    close: agentClose,
  }));
  const resume = vi.fn(async () => ({
    agentId: "agent-cursor-agent-sdk-test",
    send,
    close: agentClose,
  }));
  const listRuns = vi.fn(async (_agentId: string, options?: ListRunsOptions) => {
    runOperations.push("agent.listRuns");
    // Mirrors the SDK's opaque cursor pagination with its default page size of 50.
    const offset = options?.cursor === undefined ? 0 : Number(options.cursor);
    const end = offset + (options?.limit ?? 50);
    return {
      items: storedRuns.slice(offset, end),
      ...(end < storedRuns.length ? { nextCursor: String(end) } : {}),
    };
  });
  const cancelRun = vi.fn(async (runId: string) => {
    runOperations.push("agent.cancelRun");
    storedRuns = storedRuns.map((run) =>
      run.id === runId ? { ...run, status: "cancelled" } : run,
    );
  });

  return {
    agentClose,
    cancelRun,
    closeExecutionOrder,
    create,
    listRuns,
    resume,
    runOperations,
    runCancel,
    runSteer,
    runWait,
    send,
    setAgentCloseFailure: (failure: unknown) => {
      agentCloseFailure = failure;
    },
    setStoredRuns: (runs: Array<{ readonly id: string; readonly status: string }>) => {
      storedRuns = runs;
    },
  };
});

vi.mock("./sdk.ts", () => ({
  loadCursorSdk: () => ({
    Agent: {
      create: cursorSdkMock.create,
      resume: cursorSdkMock.resume,
      listRuns: cursorSdkMock.listRuns,
      cancelRun: cursorSdkMock.cancelRun,
      messages: {
        list: vi.fn(async () => []),
      },
    },
    createAgentPlatform: vi.fn(),
  }),
  loadCursorSqlite: () => ({ SqliteLocalAgentStore: { open: vi.fn() } }),
}));

const layerTest = CursorAgentSdk.layer.pipe(
  Layer.provide(
    Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, {
      native: {
        filePath: "cursor-agent-sdk-test.log",
        write: (event: unknown) =>
          Effect.sync(() => {
            if (
              typeof event === "object" &&
              event !== null &&
              Reflect.get(Reflect.get(event, "event"), "payload")?.type === "agent.close"
            ) {
              cursorSdkMock.closeExecutionOrder.push("protocol:agent.close");
            }
          }),
        close: () => Effect.void,
      },
      canonical: undefined,
    }),
  ),
  Layer.provide(CursorSdk.layer),
  Layer.provide(NodeServices.layer),
);

describe("CursorAgentSdkRunner", () => {
  it.effect("resumes from the original store after the working directory changes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-resume-" });
      const loaders = yield* Effect.promise(() =>
        vi.importActual<typeof import("./sdk.ts")>("./sdk.ts"),
      );
      const sdk = loaders.loadCursorSdk();
      const store = new sdk.JsonlLocalAgentStore(workspace);
      const storeCwd = `${workspace}/checkout`;
      const cwd = `${workspace}/worktree`;
      const platform = yield* Effect.promise(() =>
        sdk.createAgentPlatform({ localStore: store, workspaceRef: storeCwd }),
      );
      const { agent, run } = yield* Effect.promise(() =>
        platform.store.createAgent({ agentId: "agent-moved", workspaceRef: storeCwd }),
      );
      const runner = yield* CursorAgentSdk.makeCursorAgentSdkRunner(() => undefined).pipe(
        Effect.provideService(CursorSdk.CursorSdk, {
          load: loaders.loadCursorSdk,
          loadSqlite: loaders.loadCursorSqlite,
        }),
      );
      const session = yield* runner.open({
        operation: "resume",
        agentId: agent.agentId,
        storeCwd,
        options: { apiKey: "synthetic-cursor-key", local: { cwd, store } },
        threadId: ThreadId.make("moved-workspace"),
        providerSessionId: ProviderSessionId.make("moved-workspace"),
      });
      assert.equal(session.agentId, agent.agentId);
      assert.deepStrictEqual(yield* session.listMessages, []);
      assert.strictEqual(yield* session.readContextUsage!, undefined);

      // Cursor's conversation holds a run's request only once that run saved its own checkpoint.
      assert.isFalse(yield* session.runCheckpointed!());
      yield* Effect.promise(() =>
        platform.store.patchCheckpoint(agent.agentId, run.runId, {
          blobId: "checkpoint-1",
          storeKind: "local",
        }),
      );
      assert.isTrue(yield* session.runCheckpointed!());
      yield* Effect.promise(() =>
        platform.store.markRunTerminal(agent.agentId, run.runId, { status: "CANCELLED" }),
      );
      const followUp = yield* Effect.promise(() =>
        platform.store.createFollowUpRun(agent.agentId, {}),
      );
      assert.isFalse(yield* session.runCheckpointed!(), "the follow-up has no checkpoint yet");
      assert.isTrue(yield* session.runCheckpointed!(run.runId));
      assert.isFalse(yield* session.runCheckpointed!(followUp.runId));
      yield* session.close;
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rewinds the agent to the state its first unwound run started from", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-rewind-" });
      const loaders = yield* Effect.promise(() =>
        vi.importActual<typeof import("./sdk.ts")>("./sdk.ts"),
      );
      const sdk = loaders.loadCursorSdk();
      const store = new sdk.JsonlLocalAgentStore(workspace);
      const platform = yield* Effect.promise(() =>
        sdk.createAgentPlatform({ localStore: store, workspaceRef: workspace }),
      );
      const { agent, run: first } = yield* Effect.promise(() =>
        platform.store.createAgent({ agentId: "agent-rewind", workspaceRef: workspace }),
      );
      const finishRun = (runId: string, state: string) =>
        Effect.promise(async () => {
          const checkpoint = await platform.checkpointStore.saveCheckpoint(agent.agentId, {
            toBinary: () => new TextEncoder().encode(state),
          });
          await platform.store.patchCheckpoint(agent.agentId, runId, checkpoint);
          await platform.store.markRunTerminal(agent.agentId, runId, { status: "FINISHED" });
          return checkpoint.blobId;
        });
      const followUp = Effect.promise(() => platform.store.createFollowUpRun(agent.agentId, {}));
      const head = Effect.promise(
        async () => (await platform.store.getAgent(agent.agentId))?.latestCheckpointRef?.blobId,
      );

      const afterFirst = yield* finishRun(first.runId, "after first");
      const second = yield* followUp;
      yield* finishRun(second.runId, "after second");
      const third = yield* followUp;
      const afterThird = yield* finishRun(third.runId, "after third");

      const runner = yield* CursorAgentSdk.makeCursorAgentSdkRunner(() => undefined).pipe(
        Effect.provideService(CursorSdk.CursorSdk, {
          load: loaders.loadCursorSdk,
          loadSqlite: loaders.loadCursorSqlite,
        }),
      );
      const session = yield* runner.open({
        operation: "resume",
        agentId: agent.agentId,
        storeCwd: workspace,
        options: { apiKey: "synthetic-cursor-key", local: { cwd: workspace, store } },
        threadId: ThreadId.make("rewind"),
        providerSessionId: ProviderSessionId.make("rewind"),
      });

      yield* session.rewindAfterRun!(third.runId);
      assert.strictEqual(yield* head, afterThird, "nothing ran after the kept run");
      yield* session.rewindAfterRun!(first.runId);
      assert.strictEqual(yield* head, afterFirst);
      yield* session.close;
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("constructs without loading and reports first-use load failures as runner errors", () =>
    Effect.gen(function* () {
      const failure = new Error("missing SDK chunk");
      const load = vi.fn(() => {
        throw failure;
      });
      const runner = yield* CursorAgentSdk.makeCursorAgentSdkRunner(() => undefined).pipe(
        Effect.provideService(CursorSdk.CursorSdk, {
          load,
          loadSqlite: () => {
            throw new Error("unused SQLite");
          },
        }),
      );
      assert.strictEqual(load.mock.calls.length, 0);
      const result = yield* runner
        .open({
          operation: "create",
          options: {},
          threadId: ThreadId.make("lazy-load"),
          providerSessionId: ProviderSessionId.make("lazy-load"),
        })
        .pipe(Effect.exit);
      assert(Exit.isFailure(result));
      assert.deepStrictEqual(
        Cause.squash(result.cause),
        new CursorAgentSdk.CursorAgentSdkRunnerError({
          method: "agent.create",
          cause: failure,
        }),
      );
      assert.strictEqual(load.mock.calls.length, 1);
    }),
  );

  it.effect("retries a resumed send after cancelling its abandoned local run", () =>
    Effect.gen(function* () {
      cursorSdkMock.runOperations.length = 0;
      cursorSdkMock.listRuns.mockClear();
      cursorSdkMock.cancelRun.mockClear();
      cursorSdkMock.setStoredRuns([
        ...Array.from({ length: 50 }, (_, index) => ({
          id: `run-terminal-${index}`,
          status: index === 0 ? "cancelled" : "finished",
        })),
        { id: "run-stale", status: "running" },
      ]);

      const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
      const session = yield* runner.open({
        operation: "resume",
        agentId: "agent-cursor-agent-sdk-test",
        options: { model: { id: "default" }, mode: "agent", local: { cwd: process.cwd() } },
        threadId: ThreadId.make("thread-cursor-agent-sdk-stale-run-test"),
        providerSessionId: ProviderSessionId.make(
          "provider-session-cursor-agent-sdk-stale-run-test",
        ),
      });
      assert.deepStrictEqual(cursorSdkMock.runOperations, []);
      const run = yield* session.send({ message: "continue" });
      yield* run.wait;

      assert.deepStrictEqual(cursorSdkMock.runOperations, [
        "run.start",
        "agent.listRuns",
        "agent.listRuns",
        "agent.cancelRun",
        "run.start",
      ]);
      assert.deepStrictEqual(cursorSdkMock.listRuns.mock.calls[0], [
        "agent-cursor-agent-sdk-test",
        { runtime: "local", cwd: process.cwd() },
      ]);
      assert.strictEqual(cursorSdkMock.listRuns.mock.calls.length, 2);
      assert.deepStrictEqual(cursorSdkMock.listRuns.mock.calls[1], [
        "agent-cursor-agent-sdk-test",
        { runtime: "local", cwd: process.cwd(), cursor: "50" },
      ]);
      assert.deepStrictEqual(cursorSdkMock.cancelRun.mock.calls[0], [
        "run-stale",
        {
          runtime: "local",
          cwd: process.cwd(),
        },
      ]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("forwards the agent's own shell stream output as shell-output-delta", () =>
    Effect.gen(function* () {
      const publish = (conversationId: string, data: string) =>
        (Reflect.get(globalThis, Symbol.for("@cursor/sdk.shellStreamOutput")) as Function)({
          conversationId,
          toolCallId: "tool-shell",
          event: { case: "stdout", value: { data } },
        });
      cursorSdkMock.runWait.mockImplementationOnce(async () => {
        publish("agent-cursor-agent-sdk-test", "tick 1\n");
        publish("agent-someone-else", "not ours\n");
        return {
          id: "run-cursor-agent-sdk-test",
          requestId: "request-cursor-agent-sdk-test",
          status: "finished",
          result: "ok",
          model: { id: "default" },
          durationMs: 1,
        };
      });
      const updates: Array<unknown> = [];
      const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
      const session = yield* runner.open({
        operation: "create",
        options: {},
        threadId: ThreadId.make("thread-cursor-agent-sdk-shell"),
        providerSessionId: ProviderSessionId.make("provider-session-cursor-agent-sdk-shell"),
      });
      const run = yield* session.send({
        message: "run it",
        onDelta: (update) => Effect.sync(() => updates.push(update)),
      });
      yield* run.wait;
      publish("agent-cursor-agent-sdk-test", "after the run\n");

      assert.deepStrictEqual(
        updates.filter(
          (update) => (update as { readonly type: string }).type === "shell-output-delta",
        ),
        [
          {
            type: "shell-output-delta",
            event: { case: "stdout", value: { data: "tick 1\n" }, toolCallId: "tool-shell" },
          },
        ],
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("keeps an agent's background shells and reports each start and end in order", () =>
    Effect.gen(function* () {
      const start = (conversationId: string, id: number) => {
        let complete: (completion: object) => void = () => {};
        const abort = vi.fn();
        const kept: unknown = (
          Reflect.get(globalThis, Symbol.for("@cursor/sdk.backgroundShell")) as Function
        )({
          conversationId,
          command: "sleep 60",
          shell: {
            id,
            pid: id + 1,
            abort,
            onComplete: (listener: typeof complete) => (complete = listener),
          },
        });
        return { kept, abort, complete: (completion: object) => complete(completion) };
      };
      const events: Array<object> = [];
      const stops: Array<() => void> = [];
      const reported = yield* Deferred.make<void>();
      const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
      const session = yield* runner.open({
        operation: "create",
        options: {},
        threadId: ThreadId.make("thread-cursor-agent-sdk-background"),
        providerSessionId: ProviderSessionId.make("provider-session-cursor-agent-sdk-background"),
      });
      const run = yield* session.send({
        message: "watch it",
        onBackgroundShell: (event) =>
          Effect.gen(function* () {
            if (event.type === "started") {
              const { stop, ...started } = event;
              stops.push(stop);
              events.push(started);
              return;
            }
            events.push(event);
            if (!event.stopped) yield* Deferred.succeed(reported, undefined);
          }),
      });
      yield* run.wait;

      const killed = start("agent-cursor-agent-sdk-test", 10);
      const finished = start("agent-cursor-agent-sdk-test", 20);
      const foreign = start("agent-someone-else", 30);
      killed.complete({ code: null, aborted: true });
      finished.complete({ code: 3, aborted: false, outputPath: "/terminals/20.txt" });
      yield* Deferred.await(reported);
      stops[0]!();

      assert.deepStrictEqual([killed.kept, finished.kept, foreign.kept], [true, true, false]);
      assert.strictEqual(killed.abort.mock.calls.length, 1);
      const shell = (id: string, pid: number) => ({ id, pid, command: "sleep 60" });
      assert.deepStrictEqual(events, [
        { ...shell("10", 11), type: "started" },
        { ...shell("20", 21), type: "started" },
        {
          ...shell("10", 11),
          type: "ended",
          stopped: true,
          exitCode: undefined,
          outputPath: undefined,
        },
        {
          ...shell("20", 21),
          type: "ended",
          stopped: false,
          exitCode: 3,
          outputPath: "/terminals/20.txt",
        },
      ]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("forwards Run.steer and reports a missing method as a follow-up", () =>
    Effect.gen(function* () {
      cursorSdkMock.runSteer.mockClear();
      const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
      const session = yield* runner.open({
        operation: "create",
        options: {},
        threadId: ThreadId.make("thread-cursor-agent-sdk-steer"),
        providerSessionId: ProviderSessionId.make("provider-session-cursor-agent-sdk-steer"),
      });
      const run = yield* session.send({ message: "continue" });
      assert.equal(yield* run.steer!("keep going"), "complete_delivered");
      assert.deepStrictEqual(cursorSdkMock.runSteer.mock.calls, [["keep going"]]);

      cursorSdkMock.runSteer.mockImplementationOnce(async () => {
        throw new Error("steer transport failed");
      });
      const failed = yield* run.steer!("again").pipe(Effect.exit);
      assert(Exit.isFailure(failed));

      cursorSdkMock.send.mockImplementationOnce(async () => ({
        id: "run-without-steer",
        agentId: "agent-cursor-agent-sdk-test",
        wait: cursorSdkMock.runWait,
        cancel: cursorSdkMock.runCancel,
        steer: undefined,
      }));
      const plain = yield* session.send({ message: "plain" });
      assert.equal(yield* plain.steer!("later"), "revert_to_followup");
    }).pipe(Effect.provide(layerTest)),
  );
});
