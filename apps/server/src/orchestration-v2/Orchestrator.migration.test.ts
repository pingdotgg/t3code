import { assert, expect, it } from "@effect/vitest";
import {
  CommandId,
  ContextHandoffId,
  OrchestrationV2Command,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  appendContextHandoffId,
  canReplayCommandReceipt,
  OrchestratorV2,
  shouldPrepareLegacyImportHandoff,
} from "./Orchestrator.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

it("reissues imported context until a V2 run completes", () => {
  assert.isTrue(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: true,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: undefined,
      hasCompletedRun: false,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 0,
    }),
  );
});

it("records a reissued legacy handoff on an existing provider thread", () => {
  const existingHandoffId = ContextHandoffId.make("handoff:legacy-import:existing");
  const retryHandoffId = ContextHandoffId.make("handoff:legacy-import:retry");

  assert.deepEqual(appendContextHandoffId([existingHandoffId], retryHandoffId), [
    existingHandoffId,
    retryHandoffId,
  ]);
  assert.deepEqual(appendContextHandoffId([existingHandoffId], existingHandoffId), [
    existingHandoffId,
  ]);
  assert.deepEqual(appendContextHandoffId([existingHandoffId], null), [existingHandoffId]);
});

it("only replays a command receipt for the thread it was recorded against", () => {
  const threadA = ThreadId.make("thread-a");
  const threadB = ThreadId.make("thread-b");

  assert.strictEqual(canReplayCommandReceipt(threadA, threadA), true);
  // A reused command id aimed at another thread must not report the first
  // thread's success as this thread's (v1 #5246).
  assert.strictEqual(canReplayCommandReceipt(threadA, threadB), false);
});

it.effect("rejects a cross-thread command id that loses the commit race", () =>
  Effect.gen(function* () {
    const commandId = CommandId.make("command:cross-thread-commit-race");
    const arrived = yield* Ref.make(0);
    const release = yield* Deferred.make<void>();
    const testLayer = makeOrchestratorV2ReplayLayerWithRegistry(
      { name: "cross-thread-command-id-race" },
      Layer.mock(ProviderAdapterRegistryV2)({}),
      {
        runEffectWorker: false,
        transformEventSink: (delegate) => ({
          ...delegate,
          commitCommand: (input) =>
            input.commandId !== commandId
              ? delegate.commitCommand(input)
              : Effect.gen(function* () {
                  const count = yield* Ref.updateAndGet(arrived, (value) => value + 1);
                  if (count === 2) yield* Deferred.succeed(release, undefined);
                  yield* Deferred.await(release);
                  return yield* delegate.commitCommand(input);
                }),
        }),
      },
    );

    yield* Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const create = (threadId: ThreadId) =>
        orchestrator.dispatch({
          type: "thread.create",
          commandId,
          threadId,
          projectId: ProjectId.make("project:cross-thread-command-id-race"),
          title: String(threadId),
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6-sol",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "agent",
          creationSource: "mcp",
        });
      const results = yield* Effect.all(
        [
          create(ThreadId.make("thread:cross-thread-race:a")).pipe(Effect.result),
          create(ThreadId.make("thread:cross-thread-race:b")).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      const accepted = results.filter(Result.isSuccess);
      const rejected = results.filter(Result.isFailure);
      expect(accepted).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.failure).toMatchObject({
        _tag: "OrchestratorCommandIdConflictError",
        commandId,
      });
      expect((yield* orchestrator.getShellSnapshot()).threads).toHaveLength(1);
    }).pipe(Effect.provide(testLayer));
  }),
);

it("links and unlinks a pull request through thread.metadata.update (#8160)", () => {
  // The fold is exercised through the schema: a command carrying the link
  // must round-trip, and one without it must leave the field untouched.
  const decode = Schema.decodeUnknownSync(OrchestrationV2Command);
  const linked = decode({
    type: "thread.metadata.update",
    commandId: "command-link",
    threadId: "thread-1",
    linkedPullRequest: {
      projectId: "project-1",
      repository: "pingdotgg/t3code",
      number: 8160,
      url: "https://github.com/pingdotgg/t3code/pull/8160",
    },
  });
  assert.deepStrictEqual(
    (linked as Extract<typeof linked, { type: "thread.metadata.update" }>).linkedPullRequest,
    {
      projectId: "project-1",
      repository: "pingdotgg/t3code",
      number: 8160,
      url: "https://github.com/pingdotgg/t3code/pull/8160",
    },
  );
  const unlinked = decode({
    type: "thread.metadata.update",
    commandId: "command-unlink",
    threadId: "thread-1",
    linkedPullRequest: null,
  });
  assert.strictEqual(
    (unlinked as Extract<typeof unlinked, { type: "thread.metadata.update" }>).linkedPullRequest,
    null,
  );
});
