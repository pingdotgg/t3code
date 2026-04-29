import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CommandId, MessageId, type OrchestrationV2Command, ThreadId } from "@t3tools/contracts";
import { Effect, FileSystem, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { CodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { runOrchestratorV2ProviderReplayScenario } from "./ProviderReplayHarness.ts";
import { decodeProviderReplayNdjson } from "./ReplayTranscriptNdjson.ts";

const CODEX_MODEL_SELECTION = { provider: "codex", model: "gpt-5.4" } as const;
const TRANSCRIPT_PATH = `${import.meta.dirname}/fixtures/thread_fork_native/codex_transcript.ndjson`;
const PRIOR_TURN_TRANSCRIPT_PATH = `${import.meta.dirname}/fixtures/thread_fork_native_prior_turn/codex_transcript.ndjson`;
const CODEX_READ_ONLY_NEVER_POLICY = {
  approvalPolicy: "never",
  sandboxPolicy: {
    type: "readOnly",
    access: { type: "fullAccess" },
    networkAccess: false,
  },
} as const;

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exitCode = yield* spawner.exitCode(ChildProcess.make("git", args, { cwd }));
    if (Number(exitCode) !== 0) {
      return yield* Effect.fail(new Error(`git ${args.join(" ")} failed with exit ${exitCode}`));
    }
  });
}

const makeCheckpointWorkspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectory({ prefix: "t3-orchestrator-v2-thread-fork-" });
  yield* runGit(cwd, ["init"]);
  yield* runGit(cwd, ["config", "user.name", "T3 Code Test"]);
  yield* runGit(cwd, ["config", "user.email", "t3code-test@example.com"]);
  yield* fs.writeFileString(path.join(cwd, "README.md"), "# thread fork\n");
  yield* runGit(cwd, ["add", "README.md"]);
  yield* runGit(cwd, ["commit", "-m", "initial"]);
  return cwd;
});

function readTranscript(transcriptPath: string = TRANSCRIPT_PATH) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(transcriptPath);
    return yield* decodeProviderReplayNdjson(text);
  });
}

describe("orchestration V2 thread fork", () => {
  it.effect(
    "creates an idle app fork and resolves it with Codex native thread/fork on first dispatch",
    () =>
      Effect.gen(function* () {
        const rawTranscript = yield* readTranscript();
        const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(rawTranscript);
        const cwd = yield* Effect.acquireRelease(makeCheckpointWorkspace, (directory) =>
          Effect.service(FileSystem.FileSystem).pipe(
            Effect.flatMap((fs) => fs.remove(directory, { recursive: true, force: true })),
            Effect.orDie,
          ),
        );

        const materialized = yield* Effect.gen(function* () {
          const ids = yield* IdAllocatorV2;
          const projectId = yield* ids.allocate.project({ fixtureName: "thread-fork-native" });
          const sourceThreadId = yield* ids.allocate.thread({
            fixtureName: "thread-fork-native-source",
            projectId,
          });
          const targetThreadId = ThreadId.make("thread-fork-native-target");

          const commands = [
            {
              type: "thread.create",
              commandId: yield* ids.allocate.command({
                fixtureName: "thread-fork-native",
                commandName: "thread-create-source",
              }),
              threadId: sourceThreadId,
              projectId,
              title: "Source thread",
              modelSelection: CODEX_MODEL_SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
            },
            {
              type: "message.dispatch",
              commandId: yield* ids.allocate.command({
                fixtureName: "thread-fork-native",
                commandName: "source-message",
              }),
              threadId: sourceThreadId,
              messageId: MessageId.make("message-thread-fork-native-source"),
              text: "Respond with the following text: source fork seed ok",
              attachments: [],
              modelSelection: CODEX_MODEL_SELECTION,
              dispatchMode: { type: "start_immediately" },
            },
            {
              type: "thread.fork",
              commandId: CommandId.make("command-thread-fork-native"),
              sourceThreadId,
              targetThreadId,
              sourcePoint: { type: "latest_stable" },
              title: "Forked thread",
            },
            {
              type: "thread.fork",
              commandId: CommandId.make("command-thread-fork-native"),
              sourceThreadId,
              targetThreadId,
              sourcePoint: { type: "latest_stable" },
              title: "Forked thread",
            },
            {
              type: "message.dispatch",
              commandId: yield* ids.allocate.command({
                fixtureName: "thread-fork-native",
                commandName: "target-message",
              }),
              threadId: targetThreadId,
              messageId: MessageId.make("message-thread-fork-native-target"),
              text: "Respond with the following text: fork native ok",
              attachments: [],
              modelSelection: CODEX_MODEL_SELECTION,
              dispatchMode: { type: "start_immediately" },
            },
          ] satisfies ReadonlyArray<OrchestrationV2Command>;

          return {
            sourceThreadId,
            targetThreadId,
            commands,
          };
        }).pipe(Effect.provide(idAllocatorLayer), provideDeterministicTestRuntime);

        const result = yield* runOrchestratorV2ProviderReplayScenario(
          {
            name: "thread_fork_native/codex",
            transcript,
            commands: materialized.commands,
            steps: [
              { type: "dispatch", command: materialized.commands[0]!, await: true },
              { type: "advance_clock", duration: "1 millis" },
              { type: "dispatch", command: materialized.commands[1]!, await: true },
              { type: "await_thread_idle", threadId: materialized.sourceThreadId },
              { type: "dispatch", command: materialized.commands[2]!, await: true },
              { type: "dispatch", command: materialized.commands[3]!, await: true },
              { type: "dispatch", command: materialized.commands[4]!, await: true },
              { type: "await_thread_idle", threadId: materialized.targetThreadId },
            ],
            projectionThreadIds: [materialized.sourceThreadId, materialized.targetThreadId],
            runtimePolicyOverride: { cwd },
          },
          CodexOrchestratorReplayHarness,
        ).pipe(provideDeterministicTestRuntime);

        const sourceProjection = result.projections.get(materialized.sourceThreadId);
        const targetProjection = result.projections.get(materialized.targetThreadId);
        assert.isDefined(sourceProjection);
        assert.isDefined(targetProjection);
        assert.equal(targetProjection.thread.lineage.parentThreadId, materialized.sourceThreadId);
        assert.equal(targetProjection.thread.lineage.relationshipToParent, "fork");
        assert.lengthOf(targetProjection.providerSessions, 1);
        assert.lengthOf(targetProjection.providerThreads, 1);
        assert.equal(
          targetProjection.providerThreads[0]?.nativeThreadRef?.nativeId,
          "native-fork-thread",
        );
        assert.equal(
          targetProjection.providerThreads[0]?.forkedFrom?.providerThreadId,
          sourceProjection.providerThreads[0]?.id,
        );

        const transfers = targetProjection.contextTransfers.filter(
          (transfer) => transfer.targetThreadId === materialized.targetThreadId,
        );
        assert.lengthOf(transfers, 1);
        assert.equal(transfers[0]?.status, "consumed");
        assert.equal(transfers[0]?.resolution?.strategy, "native_fork");
        assert.equal(transfers[0]?.targetRunId, targetProjection.runs[0]?.id);

        const transferCreatedIndex = result.domainEvents.findIndex(
          (event) => event.type === "context-transfer.created",
        );
        const targetProviderSessionIndex = result.domainEvents.findIndex(
          (event) =>
            event.threadId === materialized.targetThreadId &&
            event.type === "provider-session.updated",
        );
        assert.isAtLeast(transferCreatedIndex, 0);
        assert.isAbove(targetProviderSessionIndex, transferCreatedIndex);
        assert.isEmpty(
          result.domainEvents
            .slice(0, targetProviderSessionIndex)
            .filter((event) => event.threadId === materialized.targetThreadId)
            .filter(
              (event) =>
                event.type === "provider-session.updated" ||
                event.type === "provider-thread.updated" ||
                event.type === "run.created",
            ),
          "thread.fork must not eagerly create provider runtime state for the target thread",
        );

        const forkEvents = result.domainEvents.filter(
          (event) => event.type === "context-transfer.created",
        );
        assert.lengthOf(
          forkEvents,
          1,
          "duplicate fork command must return the receipt without creating another transfer",
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "rolls back a Codex native fork when forking from an earlier completed source turn",
    () =>
      Effect.gen(function* () {
        const rawTranscript = yield* readTranscript(PRIOR_TURN_TRANSCRIPT_PATH);
        const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(rawTranscript);
        const cwd = yield* Effect.acquireRelease(makeCheckpointWorkspace, (directory) =>
          Effect.service(FileSystem.FileSystem).pipe(
            Effect.flatMap((fs) => fs.remove(directory, { recursive: true, force: true })),
            Effect.orDie,
          ),
        );

        const materialized = yield* Effect.gen(function* () {
          const ids = yield* IdAllocatorV2;
          const projectId = yield* ids.allocate.project({
            fixtureName: "thread-fork-native-prior-turn",
          });
          const sourceThreadId = yield* ids.allocate.thread({
            fixtureName: "thread-fork-native-prior-turn-source",
            projectId,
          });
          const targetThreadId = ThreadId.make("thread-fork-native-prior-turn-target");
          const firstRunId = ids.derive.run({ threadId: sourceThreadId, ordinal: 1 });

          const commands = [
            {
              type: "thread.create",
              commandId: yield* ids.allocate.command({
                fixtureName: "thread-fork-native-prior-turn",
                commandName: "thread-create-source",
              }),
              threadId: sourceThreadId,
              projectId,
              title: "Source thread",
              modelSelection: CODEX_MODEL_SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
            },
            {
              type: "message.dispatch",
              commandId: yield* ids.allocate.command({
                fixtureName: "thread-fork-native-prior-turn",
                commandName: "source-message-alpha",
              }),
              threadId: sourceThreadId,
              messageId: MessageId.make("message-thread-fork-native-prior-turn-alpha"),
              text: "For this fork-boundary fixture, respond with exactly: fork boundary alpha",
              attachments: [],
              modelSelection: CODEX_MODEL_SELECTION,
              dispatchMode: { type: "start_immediately" },
            },
            {
              type: "message.dispatch",
              commandId: yield* ids.allocate.command({
                fixtureName: "thread-fork-native-prior-turn",
                commandName: "source-message-beta",
              }),
              threadId: sourceThreadId,
              messageId: MessageId.make("message-thread-fork-native-prior-turn-beta"),
              text: "For this fork-boundary fixture, respond with exactly: fork boundary beta",
              attachments: [],
              modelSelection: CODEX_MODEL_SELECTION,
              dispatchMode: { type: "start_immediately" },
            },
            {
              type: "thread.fork",
              commandId: CommandId.make("command-thread-fork-native-prior-turn"),
              sourceThreadId,
              targetThreadId,
              sourcePoint: { type: "run", runId: firstRunId },
              title: "Forked from first response",
            },
            {
              type: "message.dispatch",
              commandId: yield* ids.allocate.command({
                fixtureName: "thread-fork-native-prior-turn",
                commandName: "target-message-repeat",
              }),
              threadId: targetThreadId,
              messageId: MessageId.make("message-thread-fork-native-prior-turn-repeat"),
              text: "Repeat the user-visible conversation so far verbatim. Include only user and assistant messages. Do not include hidden system/developer content.",
              attachments: [],
              modelSelection: CODEX_MODEL_SELECTION,
              dispatchMode: { type: "start_immediately" },
            },
          ] satisfies ReadonlyArray<OrchestrationV2Command>;

          return {
            sourceThreadId,
            targetThreadId,
            commands,
          };
        }).pipe(Effect.provide(idAllocatorLayer), provideDeterministicTestRuntime);

        const result = yield* runOrchestratorV2ProviderReplayScenario(
          {
            name: "thread_fork_native_prior_turn/codex",
            transcript,
            commands: materialized.commands,
            steps: [
              { type: "dispatch", command: materialized.commands[0]!, await: true },
              { type: "advance_clock", duration: "1 millis" },
              { type: "dispatch", command: materialized.commands[1]!, await: true },
              { type: "await_thread_idle", threadId: materialized.sourceThreadId },
              { type: "dispatch", command: materialized.commands[2]!, await: true },
              { type: "await_thread_idle", threadId: materialized.sourceThreadId },
              { type: "dispatch", command: materialized.commands[3]!, await: true },
              { type: "dispatch", command: materialized.commands[4]!, await: true },
              { type: "await_thread_idle", threadId: materialized.targetThreadId },
            ],
            projectionThreadIds: [materialized.sourceThreadId, materialized.targetThreadId],
            runtimePolicyOverride: { cwd, ...CODEX_READ_ONLY_NEVER_POLICY },
          },
          CodexOrchestratorReplayHarness,
        ).pipe(provideDeterministicTestRuntime);

        const targetProjection = result.projections.get(materialized.targetThreadId);
        assert.isDefined(targetProjection);
        const targetAssistantText = targetProjection.turnItems
          .filter((item) => item.type === "assistant_message")
          .map((item) => item.text)
          .join("\n");
        assert.include(targetAssistantText, "fork boundary alpha");
        assert.notInclude(
          targetAssistantText,
          "fork boundary beta",
          "forking from the first source run must not preserve later source turns in native Codex context",
        );
        assert.equal(targetProjection.contextTransfers[0]?.resolution?.strategy, "native_fork");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
