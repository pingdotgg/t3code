import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  type ProviderReplayTranscript,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ClaudeOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import { CodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import {
  THREAD_FORK_NATIVE_PRIOR_TURN_ALPHA_PROMPT,
  THREAD_FORK_NATIVE_PRIOR_TURN_BETA_PROMPT,
  THREAD_FORK_NATIVE_PRIOR_TURN_REPEAT_PROMPT,
  THREAD_FORK_NATIVE_SOURCE_PROMPT,
  THREAD_FORK_NATIVE_TARGET_PROMPT,
} from "./fixtures/shared.ts";
import { runOrchestratorV2ProviderReplayScenario } from "./ProviderReplayHarness.ts";
import {
  decodeProviderReplayNdjson,
  materializeReplayTranscriptWorkspace,
} from "./ReplayTranscriptNdjson.ts";

const CODEX_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} as const;
const CLAUDE_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
} as const;
const TRANSCRIPT_PATH = `${import.meta.dirname}/fixtures/thread_fork_native/codex_transcript.ndjson`;
const PRIOR_TURN_TRANSCRIPT_PATH = `${import.meta.dirname}/fixtures/thread_fork_native_prior_turn/codex_transcript.ndjson`;
const CLAUDE_TRANSCRIPT_PATH = `${import.meta.dirname}/fixtures/thread_fork_native/claude_transcript.ndjson`;
const CLAUDE_PRIOR_TURN_TRANSCRIPT_PATH = `${import.meta.dirname}/fixtures/thread_fork_native_prior_turn/claude_transcript.ndjson`;
const CLAUDE_FORK_LOCAL_ROLLBACK_TRANSCRIPT_PATH = `${import.meta.dirname}/fixtures/thread_fork_native_fork_local_rollback/claude_transcript.ndjson`;
const CODEX_READ_ONLY_NEVER_POLICY = {
  approvalPolicy: "never",
  sandboxPolicy: {
    type: "readOnly",
    access: { type: "fullAccess" },
    networkAccess: false,
  },
} as const;

class ThreadForkGitCommandError extends Schema.TaggedError<ThreadForkGitCommandError>()(
  "ThreadForkGitCommandError",
  {
    command: Schema.String,
    exitCode: Schema.Number,
  },
) {
  override get message(): string {
    return `${this.command} failed with exit ${this.exitCode}.`;
  }
}

function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<
  void,
  ThreadForkGitCommandError | PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exitCode = yield* spawner.exitCode(ChildProcess.make("git", args, { cwd }));
    if (Number(exitCode) !== 0) {
      return yield* new ThreadForkGitCommandError({
        command: `git ${args.join(" ")}`,
        exitCode: Number(exitCode),
      });
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

function metadataString(transcript: ProviderReplayTranscript, key: string): string {
  const value = transcript.metadata?.[key];
  if (typeof value !== "string") {
    throw new Error(`Transcript ${transcript.scenario} is missing metadata string ${key}.`);
  }
  return value;
}

function metadataStringArray(
  transcript: ProviderReplayTranscript,
  key: string,
): ReadonlyArray<string> {
  const value = transcript.metadata?.[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`Transcript ${transcript.scenario} is missing metadata string array ${key}.`);
  }
  return value;
}

function userAndAssistantText(
  projection: Pick<OrchestrationV2ThreadProjection, "visibleTurnItems">,
): string {
  return projection.visibleTurnItems
    .flatMap((row) => {
      const item = row.item;
      return item.type === "user_message" || item.type === "assistant_message" ? [item.text] : [];
    })
    .join("\n");
}

describe("orchestration V2 thread fork", () => {
  it.effect(
    "creates an idle app fork and resolves it with Codex native thread/fork on first dispatch",
    () =>
      Effect.gen(function* () {
        const rawTranscript = yield* readTranscript();
        const cwd = yield* Effect.acquireRelease(makeCheckpointWorkspace, (directory) =>
          Effect.service(FileSystem.FileSystem).pipe(
            Effect.flatMap((fs) => fs.remove(directory, { recursive: true, force: true })),
            Effect.orDie,
          ),
        );
        const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
          materializeReplayTranscriptWorkspace(rawTranscript, cwd),
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
              createdBy: "user",
              creationSource: "web",
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
              createdBy: "user",
              creationSource: "web",
              commandId: yield* ids.allocate.command({
                fixtureName: "thread-fork-native",
                commandName: "source-message",
              }),
              threadId: sourceThreadId,
              messageId: MessageId.make("message-thread-fork-native-source"),
              text: THREAD_FORK_NATIVE_SOURCE_PROMPT,
              attachments: [],
              modelSelection: CODEX_MODEL_SELECTION,
              dispatchMode: { type: "start_immediately" },
            },
            {
              type: "thread.fork",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command-thread-fork-native"),
              sourceThreadId,
              targetThreadId,
              sourcePoint: { type: "latest_stable" },
              title: "Forked thread",
            },
            {
              type: "thread.fork",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command-thread-fork-native"),
              sourceThreadId,
              targetThreadId,
              sourcePoint: { type: "latest_stable" },
              title: "Forked thread",
            },
            {
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: yield* ids.allocate.command({
                fixtureName: "thread-fork-native",
                commandName: "target-message",
              }),
              threadId: targetThreadId,
              messageId: MessageId.make("message-thread-fork-native-target"),
              text: THREAD_FORK_NATIVE_TARGET_PROMPT,
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
        const targetRunCreatedIndex = result.domainEvents.findIndex(
          (event) => event.threadId === materialized.targetThreadId && event.type === "run.created",
        );
        assert.isAtLeast(transferCreatedIndex, 0);
        assert.isAbove(targetProviderSessionIndex, transferCreatedIndex);
        assert.isAbove(
          targetProviderSessionIndex,
          targetRunCreatedIndex,
          "provider runtime state must be materialized only after the target run commits",
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
    "creates an idle app fork and resolves it with Claude native session fork on first dispatch",
    () =>
      Effect.gen(function* () {
        const rawTranscript = yield* readTranscript(CLAUDE_TRANSCRIPT_PATH);
        const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(rawTranscript);
        const forkedNativeSessionId = metadataString(transcript, "forkedNativeSessionId");
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
              createdBy: "user",
              creationSource: "web",
              commandId: yield* ids.allocate.command({
                fixtureName: "thread-fork-native",
                commandName: "thread-create-source",
              }),
              threadId: sourceThreadId,
              projectId,
              title: "Source thread",
              modelSelection: CLAUDE_MODEL_SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
            },
            {
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: yield* ids.allocate.command({
                fixtureName: "thread-fork-native",
                commandName: "source-message",
              }),
              threadId: sourceThreadId,
              messageId: MessageId.make("message-thread-fork-native-source"),
              text: THREAD_FORK_NATIVE_SOURCE_PROMPT,
              attachments: [],
              modelSelection: CLAUDE_MODEL_SELECTION,
              dispatchMode: { type: "start_immediately" },
            },
            {
              type: "thread.fork",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command-thread-fork-native"),
              sourceThreadId,
              targetThreadId,
              sourcePoint: { type: "latest_stable" },
              title: "Forked thread",
            },
            {
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: yield* ids.allocate.command({
                fixtureName: "thread-fork-native",
                commandName: "target-message",
              }),
              threadId: targetThreadId,
              messageId: MessageId.make("message-thread-fork-native-target"),
              text: THREAD_FORK_NATIVE_TARGET_PROMPT,
              attachments: [],
              modelSelection: CLAUDE_MODEL_SELECTION,
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
            name: "thread_fork_native/claude",
            transcript,
            commands: materialized.commands,
            steps: [
              { type: "dispatch", command: materialized.commands[0]!, await: true },
              { type: "advance_clock", duration: "1 millis" },
              { type: "dispatch", command: materialized.commands[1]!, await: true },
              { type: "await_thread_idle", threadId: materialized.sourceThreadId },
              { type: "dispatch", command: materialized.commands[2]!, await: true },
              { type: "dispatch", command: materialized.commands[3]!, await: true },
              { type: "await_thread_idle", threadId: materialized.targetThreadId },
            ],
            projectionThreadIds: [materialized.sourceThreadId, materialized.targetThreadId],
            runtimePolicyOverride: { cwd },
          },
          ClaudeOrchestratorReplayHarness,
        ).pipe(provideDeterministicTestRuntime);

        const sourceProjection = result.projections.get(materialized.sourceThreadId);
        const targetProjection = result.projections.get(materialized.targetThreadId);
        assert.isDefined(sourceProjection);
        assert.isDefined(targetProjection);
        assert.equal(
          targetProjection.providerThreads[0]?.nativeThreadRef?.nativeId,
          forkedNativeSessionId,
        );
        assert.equal(
          targetProjection.providerThreads[0]?.forkedFrom?.providerThreadId,
          sourceProjection.providerThreads[0]?.id,
        );
        assert.include(
          targetProjection.turnItems
            .filter((item) => item.type === "assistant_message")
            .map((item) => item.text)
            .join("\n"),
          "fork native ok",
        );

        const transfers = targetProjection.contextTransfers.filter(
          (transfer) => transfer.targetThreadId === materialized.targetThreadId,
        );
        assert.lengthOf(transfers, 1);
        assert.equal(transfers[0]?.status, "consumed");
        assert.equal(transfers[0]?.resolution?.strategy, "native_fork");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("forks a Codex native thread at the selected native turn boundary", () =>
    Effect.gen(function* () {
      const rawTranscript = yield* readTranscript(PRIOR_TURN_TRANSCRIPT_PATH);
      const cwd = yield* Effect.acquireRelease(makeCheckpointWorkspace, (directory) =>
        Effect.service(FileSystem.FileSystem).pipe(
          Effect.flatMap((fs) => fs.remove(directory, { recursive: true, force: true })),
          Effect.orDie,
        ),
      );
      const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
        materializeReplayTranscriptWorkspace(rawTranscript, cwd),
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
            createdBy: "user",
            creationSource: "web",
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
            createdBy: "user",
            creationSource: "web",
            commandId: yield* ids.allocate.command({
              fixtureName: "thread-fork-native-prior-turn",
              commandName: "source-message-alpha",
            }),
            threadId: sourceThreadId,
            messageId: MessageId.make("message-thread-fork-native-prior-turn-alpha"),
            text: THREAD_FORK_NATIVE_PRIOR_TURN_ALPHA_PROMPT,
            attachments: [],
            modelSelection: CODEX_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          },
          {
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: yield* ids.allocate.command({
              fixtureName: "thread-fork-native-prior-turn",
              commandName: "source-message-beta",
            }),
            threadId: sourceThreadId,
            messageId: MessageId.make("message-thread-fork-native-prior-turn-beta"),
            text: THREAD_FORK_NATIVE_PRIOR_TURN_BETA_PROMPT,
            attachments: [],
            modelSelection: CODEX_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          },
          {
            type: "thread.fork",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command-thread-fork-native-prior-turn"),
            sourceThreadId,
            targetThreadId,
            sourcePoint: { type: "run", runId: firstRunId },
            title: "Forked from first response",
          },
          {
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: yield* ids.allocate.command({
              fixtureName: "thread-fork-native-prior-turn",
              commandName: "target-message-repeat",
            }),
            threadId: targetThreadId,
            messageId: MessageId.make("message-thread-fork-native-prior-turn-repeat"),
            text: THREAD_FORK_NATIVE_PRIOR_TURN_REPEAT_PROMPT,
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

      const visibleItems = targetProjection.visibleTurnItems.map((row) => row.item);
      assert.deepEqual(
        visibleItems.slice(0, 2).map((item) => item.type),
        ["user_message", "assistant_message"],
        "fork target projection should expose inherited source history through the fork point",
      );
      assert.equal(
        visibleItems[0]?.type === "user_message" ? visibleItems[0].inputIntent : undefined,
        "turn_start",
        "inherited fork history should preserve source message intent",
      );
      assert.equal(targetProjection.visibleTurnItems[0]?.visibility, "inherited");
      assert.equal(targetProjection.visibleTurnItems[1]?.visibility, "inherited");
      const forkMarker = targetProjection.visibleTurnItems.find((row) => row.item.type === "fork");
      assert.isDefined(forkMarker, "fork target projection should include a visible fork marker");
      assert.equal(forkMarker.visibility, "synthetic");
      const targetShell = result.shellSnapshot.threads.find(
        (thread) => thread.id === materialized.targetThreadId,
      );
      assert.isDefined(targetShell, "shell snapshot should include the fork target thread");
      assert.equal(targetShell.visibleItemCount, targetProjection.visibleTurnItems.length);
      assert.equal(targetShell.lineage.relationshipToParent, "fork");
      assert.equal(targetShell.forkedFrom?.type, "run");

      const visibleText = visibleItems
        .filter((item) => item.type === "user_message" || item.type === "assistant_message")
        .map((item) => item.text)
        .join("\n");
      assert.include(visibleText, "fork boundary alpha");
      assert.notInclude(
        visibleText,
        "fork boundary beta",
        "fork target visible projection must not inherit source turns after the fork point",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("forks a Claude native session from an earlier completed source turn", () =>
    Effect.gen(function* () {
      const rawTranscript = yield* readTranscript(CLAUDE_PRIOR_TURN_TRANSCRIPT_PATH);
      const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(rawTranscript);
      const forkedNativeSessionId = metadataString(transcript, "forkedNativeSessionId");
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
            createdBy: "user",
            creationSource: "web",
            commandId: yield* ids.allocate.command({
              fixtureName: "thread-fork-native-prior-turn",
              commandName: "thread-create-source",
            }),
            threadId: sourceThreadId,
            projectId,
            title: "Source thread",
            modelSelection: CLAUDE_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          },
          {
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: yield* ids.allocate.command({
              fixtureName: "thread-fork-native-prior-turn",
              commandName: "source-message-alpha",
            }),
            threadId: sourceThreadId,
            messageId: MessageId.make("message-thread-fork-native-prior-turn-alpha"),
            text: THREAD_FORK_NATIVE_PRIOR_TURN_ALPHA_PROMPT,
            attachments: [],
            modelSelection: CLAUDE_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          },
          {
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: yield* ids.allocate.command({
              fixtureName: "thread-fork-native-prior-turn",
              commandName: "source-message-beta",
            }),
            threadId: sourceThreadId,
            messageId: MessageId.make("message-thread-fork-native-prior-turn-beta"),
            text: THREAD_FORK_NATIVE_PRIOR_TURN_BETA_PROMPT,
            attachments: [],
            modelSelection: CLAUDE_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          },
          {
            type: "thread.fork",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command-thread-fork-native-prior-turn"),
            sourceThreadId,
            targetThreadId,
            sourcePoint: { type: "run", runId: firstRunId },
            title: "Forked from first response",
          },
          {
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: yield* ids.allocate.command({
              fixtureName: "thread-fork-native-prior-turn",
              commandName: "target-message-repeat",
            }),
            threadId: targetThreadId,
            messageId: MessageId.make("message-thread-fork-native-prior-turn-repeat"),
            text: THREAD_FORK_NATIVE_PRIOR_TURN_REPEAT_PROMPT,
            attachments: [],
            modelSelection: CLAUDE_MODEL_SELECTION,
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
          name: "thread_fork_native_prior_turn/claude",
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
          runtimePolicyOverride: { cwd },
        },
        ClaudeOrchestratorReplayHarness,
      ).pipe(provideDeterministicTestRuntime);

      const targetProjection = result.projections.get(materialized.targetThreadId);
      assert.isDefined(targetProjection);
      assert.equal(
        targetProjection.providerThreads[0]?.nativeThreadRef?.nativeId,
        forkedNativeSessionId,
      );
      const targetAssistantText = targetProjection.turnItems
        .filter((item) => item.type === "assistant_message")
        .map((item) => item.text)
        .join("\n");
      assert.include(targetAssistantText, "fork boundary alpha");
      assert.notInclude(
        targetAssistantText,
        "fork boundary beta",
        "forking from the first source run must not preserve later source turns in native Claude context",
      );
      assert.equal(targetProjection.contextTransfers[0]?.resolution?.strategy, "native_fork");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a Claude native fork stable when the source thread rolls back", () =>
    Effect.gen(function* () {
      const rawTranscript = yield* readTranscript(CLAUDE_PRIOR_TURN_TRANSCRIPT_PATH);
      const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(rawTranscript);
      const forkedNativeSessionId = metadataString(transcript, "forkedNativeSessionId");
      const sourceAssistantMessageUuids = metadataStringArray(
        transcript,
        "sourceAssistantMessageUuids",
      );
      const cwd = yield* Effect.acquireRelease(makeCheckpointWorkspace, (directory) =>
        Effect.service(FileSystem.FileSystem).pipe(
          Effect.flatMap((fs) => fs.remove(directory, { recursive: true, force: true })),
          Effect.orDie,
        ),
      );

      const materialized = yield* Effect.gen(function* () {
        const ids = yield* IdAllocatorV2;
        const projectId = yield* ids.allocate.project({
          fixtureName: "thread-fork-native-prior-turn-source-rollback",
        });
        const sourceThreadId = yield* ids.allocate.thread({
          fixtureName: "thread-fork-native-prior-turn-source-rollback-source",
          projectId,
        });
        const targetThreadId = ThreadId.make(
          "thread-fork-native-prior-turn-source-rollback-target",
        );
        const firstRunId = ids.derive.run({ threadId: sourceThreadId, ordinal: 1 });
        const secondRunId = ids.derive.run({ threadId: sourceThreadId, ordinal: 2 });
        const checkpointScopeId = yield* ids.allocate.checkpointScope({
          threadId: sourceThreadId,
          name: "root",
        });
        const firstCheckpointId = yield* ids.allocate.checkpoint({
          checkpointScopeId,
          name: "1",
        });

        const commands = [
          {
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: yield* ids.allocate.command({
              fixtureName: "thread-fork-native-prior-turn-source-rollback",
              commandName: "thread-create-source",
            }),
            threadId: sourceThreadId,
            projectId,
            title: "Source thread",
            modelSelection: CLAUDE_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          },
          {
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: yield* ids.allocate.command({
              fixtureName: "thread-fork-native-prior-turn-source-rollback",
              commandName: "source-message-alpha",
            }),
            threadId: sourceThreadId,
            messageId: MessageId.make(
              "message-thread-fork-native-prior-turn-source-rollback-alpha",
            ),
            text: THREAD_FORK_NATIVE_PRIOR_TURN_ALPHA_PROMPT,
            attachments: [],
            modelSelection: CLAUDE_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          },
          {
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: yield* ids.allocate.command({
              fixtureName: "thread-fork-native-prior-turn-source-rollback",
              commandName: "source-message-beta",
            }),
            threadId: sourceThreadId,
            messageId: MessageId.make("message-thread-fork-native-prior-turn-source-rollback-beta"),
            text: THREAD_FORK_NATIVE_PRIOR_TURN_BETA_PROMPT,
            attachments: [],
            modelSelection: CLAUDE_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          },
          {
            type: "thread.fork",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command-thread-fork-native-prior-turn-source-rollback"),
            sourceThreadId,
            targetThreadId,
            sourcePoint: { type: "run", runId: firstRunId },
            title: "Forked from first response",
          },
          {
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: yield* ids.allocate.command({
              fixtureName: "thread-fork-native-prior-turn-source-rollback",
              commandName: "target-message-repeat",
            }),
            threadId: targetThreadId,
            messageId: MessageId.make(
              "message-thread-fork-native-prior-turn-source-rollback-repeat",
            ),
            text: THREAD_FORK_NATIVE_PRIOR_TURN_REPEAT_PROMPT,
            attachments: [],
            modelSelection: CLAUDE_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          },
          {
            type: "checkpoint.rollback",
            restoreFiles: false,
            commandId: yield* ids.allocate.command({
              fixtureName: "thread-fork-native-prior-turn-source-rollback",
              commandName: "rollback-source-to-alpha",
            }),
            threadId: sourceThreadId,
            scopeId: checkpointScopeId,
            checkpointId: firstCheckpointId,
            restoreFiles: false,
          },
        ] satisfies ReadonlyArray<OrchestrationV2Command>;

        return {
          sourceThreadId,
          targetThreadId,
          secondRunId,
          commands,
        };
      }).pipe(Effect.provide(idAllocatorLayer), provideDeterministicTestRuntime);

      const result = yield* runOrchestratorV2ProviderReplayScenario(
        {
          name: "thread_fork_native_prior_turn_source_rollback/claude",
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
            { type: "dispatch", command: materialized.commands[5]!, await: true },
            {
              type: "await_run_status",
              threadId: materialized.sourceThreadId,
              runId: materialized.secondRunId,
              status: "rolled_back",
            },
          ],
          projectionThreadIds: [materialized.sourceThreadId, materialized.targetThreadId],
          runtimePolicyOverride: { cwd },
        },
        ClaudeOrchestratorReplayHarness,
      ).pipe(provideDeterministicTestRuntime);

      const sourceProjection = result.projections.get(materialized.sourceThreadId);
      const targetProjection = result.projections.get(materialized.targetThreadId);
      assert.isDefined(sourceProjection);
      assert.isDefined(targetProjection);

      assert.equal(
        sourceProjection.runs.map((run) => run.status).join(","),
        "completed,rolled_back",
      );
      assert.equal(
        sourceProjection.providerThreads[0]?.nativeConversationHeadRef?.nativeId,
        sourceAssistantMessageUuids[0],
        "source rollback should persist the Claude resume cursor for the first assistant message",
      );
      assert.equal(
        targetProjection.providerThreads[0]?.nativeThreadRef?.nativeId,
        forkedNativeSessionId,
      );
      assert.equal(targetProjection.providerThreads[0]?.nativeConversationHeadRef, null);

      const sourceVisibleText = userAndAssistantText(sourceProjection);
      assert.include(sourceVisibleText, "fork boundary alpha");
      assert.notInclude(sourceVisibleText, "fork boundary beta");

      const targetVisibleText = userAndAssistantText(targetProjection);
      assert.include(targetVisibleText, "fork boundary alpha");
      assert.notInclude(
        targetVisibleText,
        "fork boundary beta",
        "source rollback must not cause the fork target to inherit turns past its fork point",
      );
      assert.equal(targetProjection.contextTransfers[0]?.resolution?.strategy, "native_fork");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rolls back a Claude native fork to an earlier fork-local turn", () =>
    Effect.gen(function* () {
      const rawTranscript = yield* readTranscript(CLAUDE_FORK_LOCAL_ROLLBACK_TRANSCRIPT_PATH);
      const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(rawTranscript);
      const forkedNativeSessionId = metadataString(transcript, "forkedNativeSessionId");
      const resumeSessionAt = metadataString(transcript, "resumeSessionAt");
      const prompts = metadataStringArray(transcript, "prompts");
      const [sourcePrompt, forkFirstPrompt, forkSecondPrompt, repeatPrompt] = prompts;
      if (
        sourcePrompt === undefined ||
        forkFirstPrompt === undefined ||
        forkSecondPrompt === undefined ||
        repeatPrompt === undefined
      ) {
        throw new Error("Claude fork-local rollback transcript is missing expected prompts.");
      }

      const cwd = yield* Effect.acquireRelease(makeCheckpointWorkspace, (directory) =>
        Effect.service(FileSystem.FileSystem).pipe(
          Effect.flatMap((fs) => fs.remove(directory, { recursive: true, force: true })),
          Effect.orDie,
        ),
      );

      const materialized = yield* Effect.gen(function* () {
        const ids = yield* IdAllocatorV2;
        const projectId = yield* ids.allocate.project({
          fixtureName: "thread-fork-native-fork-local-rollback",
        });
        const sourceThreadId = yield* ids.allocate.thread({
          fixtureName: "thread-fork-native-fork-local-rollback-source",
          projectId,
        });
        const targetThreadId = ThreadId.make("thread-fork-native-fork-local-rollback-target");
        const targetSecondRunId = ids.derive.run({ threadId: targetThreadId, ordinal: 2 });
        const targetCheckpointScopeId = yield* ids.allocate.checkpointScope({
          threadId: targetThreadId,
          name: "root",
        });
        const targetFirstCheckpointId = yield* ids.allocate.checkpoint({
          checkpointScopeId: targetCheckpointScopeId,
          name: "1",
        });

        const commands = [
          {
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: yield* ids.allocate.command({
              fixtureName: "thread-fork-native-fork-local-rollback",
              commandName: "thread-create-source",
            }),
            threadId: sourceThreadId,
            projectId,
            title: "Source thread",
            modelSelection: CLAUDE_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          },
          {
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: yield* ids.allocate.command({
              fixtureName: "thread-fork-native-fork-local-rollback",
              commandName: "source-message",
            }),
            threadId: sourceThreadId,
            messageId: MessageId.make("message-thread-fork-native-fork-local-rollback-source"),
            text: sourcePrompt,
            attachments: [],
            modelSelection: CLAUDE_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          },
          {
            type: "thread.fork",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command-thread-fork-native-fork-local-rollback"),
            sourceThreadId,
            targetThreadId,
            sourcePoint: { type: "latest_stable" },
            title: "Forked thread",
          },
          {
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: yield* ids.allocate.command({
              fixtureName: "thread-fork-native-fork-local-rollback",
              commandName: "fork-first-message",
            }),
            threadId: targetThreadId,
            messageId: MessageId.make("message-thread-fork-native-fork-local-rollback-first"),
            text: forkFirstPrompt,
            attachments: [],
            modelSelection: CLAUDE_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          },
          {
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: yield* ids.allocate.command({
              fixtureName: "thread-fork-native-fork-local-rollback",
              commandName: "fork-second-message",
            }),
            threadId: targetThreadId,
            messageId: MessageId.make("message-thread-fork-native-fork-local-rollback-second"),
            text: forkSecondPrompt,
            attachments: [],
            modelSelection: CLAUDE_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          },
          {
            type: "checkpoint.rollback",
            restoreFiles: false,
            commandId: yield* ids.allocate.command({
              fixtureName: "thread-fork-native-fork-local-rollback",
              commandName: "rollback-fork-to-first",
            }),
            threadId: targetThreadId,
            scopeId: targetCheckpointScopeId,
            checkpointId: targetFirstCheckpointId,
            restoreFiles: false,
          },
          {
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: yield* ids.allocate.command({
              fixtureName: "thread-fork-native-fork-local-rollback",
              commandName: "fork-repeat-after-rollback",
            }),
            threadId: targetThreadId,
            messageId: MessageId.make("message-thread-fork-native-fork-local-rollback-repeat"),
            text: repeatPrompt,
            attachments: [],
            modelSelection: CLAUDE_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          },
        ] satisfies ReadonlyArray<OrchestrationV2Command>;

        return {
          sourceThreadId,
          targetThreadId,
          targetSecondRunId,
          commands,
        };
      }).pipe(Effect.provide(idAllocatorLayer), provideDeterministicTestRuntime);

      const result = yield* runOrchestratorV2ProviderReplayScenario(
        {
          name: "thread_fork_native_fork_local_rollback/claude",
          transcript,
          commands: materialized.commands,
          steps: [
            { type: "dispatch", command: materialized.commands[0]!, await: true },
            { type: "advance_clock", duration: "1 millis" },
            { type: "dispatch", command: materialized.commands[1]!, await: true },
            { type: "await_thread_idle", threadId: materialized.sourceThreadId },
            { type: "dispatch", command: materialized.commands[2]!, await: true },
            { type: "dispatch", command: materialized.commands[3]!, await: true },
            { type: "await_thread_idle", threadId: materialized.targetThreadId },
            { type: "dispatch", command: materialized.commands[4]!, await: true },
            { type: "await_thread_idle", threadId: materialized.targetThreadId },
            { type: "dispatch", command: materialized.commands[5]!, await: true },
            {
              type: "await_run_status",
              threadId: materialized.targetThreadId,
              runId: materialized.targetSecondRunId,
              status: "rolled_back",
            },
            { type: "dispatch", command: materialized.commands[6]!, await: true },
            { type: "await_thread_idle", threadId: materialized.targetThreadId },
          ],
          projectionThreadIds: [materialized.sourceThreadId, materialized.targetThreadId],
          runtimePolicyOverride: { cwd },
        },
        ClaudeOrchestratorReplayHarness,
      ).pipe(provideDeterministicTestRuntime);

      const targetProjection = result.projections.get(materialized.targetThreadId);
      assert.isDefined(targetProjection);
      assert.equal(
        targetProjection.providerThreads[0]?.nativeThreadRef?.nativeId,
        forkedNativeSessionId,
      );
      assert.isString(resumeSessionAt);

      const targetVisibleText = userAndAssistantText(targetProjection);
      assert.include(targetVisibleText, "fork local source alpha");
      assert.include(targetVisibleText, "fork local first");
      assert.notInclude(
        targetVisibleText,
        "fork local second",
        "rolled back fork-local turns must disappear from the projected fork thread",
      );

      const targetVisibleAssistantText = targetProjection.visibleTurnItems
        .map((row) => row.item)
        .filter((item) => item.type === "assistant_message")
        .map((item) => item.text)
        .join("\n");
      assert.notInclude(
        targetVisibleAssistantText,
        "fork local second",
        "resumeSessionAt must reopen the Claude fork before the rolled-back second fork turn",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
