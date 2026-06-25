import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  type ProviderReplayEntry,
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

class ThreadForkGitCommandError extends Schema.TaggedErrorClass<ThreadForkGitCommandError>()(
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

function compactExpectedText(text: string, maxLength = 240): string {
  const compacted = text.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) {
    return compacted;
  }
  return `${compacted.slice(0, maxLength - 3)}...`;
}

function findCompletedAgentMessageText(input: {
  readonly transcript: ProviderReplayTranscript;
  readonly threadId: string;
  readonly turnId: string;
}): string {
  for (const entry of input.transcript.entries) {
    if (entry.type !== "emit_inbound") {
      continue;
    }
    const frame = entry.frame as {
      readonly method?: unknown;
      readonly params?: {
        readonly threadId?: unknown;
        readonly turnId?: unknown;
        readonly item?: {
          readonly type?: unknown;
          readonly text?: unknown;
        };
      };
    };
    if (
      frame.method === "item/completed" &&
      frame.params?.threadId === input.threadId &&
      frame.params.turnId === input.turnId &&
      frame.params.item?.type === "agentMessage" &&
      typeof frame.params.item.text === "string"
    ) {
      return frame.params.item.text;
    }
  }
  throw new Error(`No completed agent message found for ${input.threadId}/${input.turnId}`);
}

function makeExpectedForkDeltaSummary(input: {
  readonly sourceThreadId: string;
  readonly targetThreadId: string;
  readonly forkUserText: string;
  readonly forkAssistantText: string;
}): string {
  return [
    "Merge-back context from forked conversation.",
    `Source thread: ${input.sourceThreadId}`,
    `Target thread: ${input.targetThreadId}`,
    "Covered fork runs: 1-1",
    "",
    "Fork delta:",
    `- User: ${compactExpectedText(input.forkUserText)}`,
    `- Assistant: ${compactExpectedText(input.forkAssistantText)}`,
    "- Checkpoint: 0 files",
  ].join("\n");
}

function transcriptWithMergeBackContinuation(input: {
  readonly transcript: ProviderReplayTranscript;
  readonly providerMessageText: string;
  readonly projectedUserText: string;
  readonly assistantText: string;
}): ProviderReplayTranscript {
  const sourceNativeThreadId = "019dd6ba-2681-7bf0-b051-141b0cbcbb27";
  const mergeBackNativeTurnId = "019dd6ba-5000-7000-8000-000000000001";
  const mergeBackUserItemId = "merge-back-user-message";
  const mergeBackAgentItemId = "merge-back-agent-message";
  const entriesWithoutExit = input.transcript.entries.filter(
    (entry) => entry.type !== "runtime_exit",
  );
  const continuation = [
    {
      type: "expect_outbound",
      label: "turn/start/merge-back-source",
      frame: {
        id: 9,
        method: "turn/start",
        params: {
          threadId: sourceNativeThreadId,
          input: [{ type: "text", text: input.providerMessageText }],
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/start/merge-back-source",
      frame: {
        id: 9,
        result: {
          turn: {
            id: mergeBackNativeTurnId,
            items: [],
            status: "inProgress",
            error: null,
            startedAt: 1777424041,
            completedAt: null,
            durationMs: null,
          },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "thread/status/changed/merge-back-source",
      frame: {
        method: "thread/status/changed",
        params: {
          threadId: sourceNativeThreadId,
          status: { type: "active", activeFlags: [] },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/started/merge-back-source",
      frame: {
        method: "turn/started",
        params: {
          threadId: sourceNativeThreadId,
          turn: {
            id: mergeBackNativeTurnId,
            items: [],
            status: "inProgress",
            error: null,
            startedAt: 1777424041,
            completedAt: null,
            durationMs: null,
          },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "item/userMessage/started/merge-back-source",
      frame: {
        method: "item/started",
        params: {
          item: {
            type: "userMessage",
            id: mergeBackUserItemId,
            content: [{ type: "text", text: input.projectedUserText, text_elements: [] }],
          },
          threadId: sourceNativeThreadId,
          turnId: mergeBackNativeTurnId,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "item/userMessage/completed/merge-back-source",
      frame: {
        method: "item/completed",
        params: {
          item: {
            type: "userMessage",
            id: mergeBackUserItemId,
            content: [{ type: "text", text: input.projectedUserText, text_elements: [] }],
          },
          threadId: sourceNativeThreadId,
          turnId: mergeBackNativeTurnId,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "item/agentMessage/started/merge-back-source",
      frame: {
        method: "item/started",
        params: {
          item: {
            type: "agentMessage",
            id: mergeBackAgentItemId,
            text: "",
            phase: "final_answer",
            memoryCitation: null,
          },
          threadId: sourceNativeThreadId,
          turnId: mergeBackNativeTurnId,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "item/agentMessage/delta/merge-back-source",
      frame: {
        method: "item/agentMessage/delta",
        params: {
          threadId: sourceNativeThreadId,
          turnId: mergeBackNativeTurnId,
          itemId: mergeBackAgentItemId,
          delta: input.assistantText,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "item/agentMessage/completed/merge-back-source",
      frame: {
        method: "item/completed",
        params: {
          item: {
            type: "agentMessage",
            id: mergeBackAgentItemId,
            text: input.assistantText,
            phase: "final_answer",
            memoryCitation: null,
          },
          threadId: sourceNativeThreadId,
          turnId: mergeBackNativeTurnId,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "thread/status/changed/merge-back-source",
      frame: {
        method: "thread/status/changed",
        params: { threadId: sourceNativeThreadId, status: { type: "idle" } },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/completed/merge-back-source",
      frame: {
        method: "turn/completed",
        params: {
          threadId: sourceNativeThreadId,
          turn: {
            id: mergeBackNativeTurnId,
            items: [],
            status: "completed",
            error: null,
            startedAt: 1777424041,
            completedAt: 1777424042,
            durationMs: 1000,
          },
        },
      },
    },
    { type: "runtime_exit", status: "success" },
  ] satisfies ReadonlyArray<ProviderReplayEntry>;

  return {
    ...input.transcript,
    scenario: `${input.transcript.scenario}_merge_back`,
    entries: [...entriesWithoutExit, ...continuation],
  };
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

  it.effect(
    "rolls back a Codex native fork when forking from an earlier completed source turn",
    () =>
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
        const forkMarker = targetProjection.visibleTurnItems.find(
          (row) => row.item.type === "fork",
        );
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
            commandId: yield* ids.allocate.command({
              fixtureName: "thread-fork-native-prior-turn-source-rollback",
              commandName: "rollback-source-to-alpha",
            }),
            threadId: sourceThreadId,
            scopeId: checkpointScopeId,
            checkpointId: firstCheckpointId,
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
            commandId: yield* ids.allocate.command({
              fixtureName: "thread-fork-native-fork-local-rollback",
              commandName: "rollback-fork-to-first",
            }),
            threadId: targetThreadId,
            scopeId: targetCheckpointScopeId,
            checkpointId: targetFirstCheckpointId,
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

  // Covered with recorded Codex and Claude provider transcripts in ThreadMergeBack.integration.
  it.skip("merges a fork delta back into the source thread through context handoff", () =>
    Effect.gen(function* () {
      const rawTranscript = yield* readTranscript(PRIOR_TURN_TRANSCRIPT_PATH);
      const forkNativeThreadId = "019dd6ba-47b7-7092-8688-9cf7fe5f6498";
      const sourceNativeThreadId = "019dd6ba-2681-7bf0-b051-141b0cbcbb27";
      const forkRepeatNativeTurnId = "019dd6ba-47eb-7041-ad45-5abe752c28c9";
      const forkPrompt = THREAD_FORK_NATIVE_PRIOR_TURN_REPEAT_PROMPT;
      const mergeBackPrompt = "Acknowledge the fork context with exactly: merge back acknowledged";
      const mergeBackAssistantText = "merge back acknowledged";
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
        const forkRunId = ids.derive.run({ threadId: targetThreadId, ordinal: 1 });

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
            text: forkPrompt,
            attachments: [],
            modelSelection: CODEX_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          },
          {
            type: "thread.merge_back",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command-thread-merge-back-native-prior-turn-stale"),
            sourceThreadId: targetThreadId,
            targetThreadId: sourceThreadId,
            sourcePoint: { type: "run", runId: forkRunId },
          },
          {
            type: "thread.merge_back",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command-thread-merge-back-native-prior-turn"),
            sourceThreadId: targetThreadId,
            targetThreadId: sourceThreadId,
            sourcePoint: { type: "run", runId: forkRunId },
          },
          {
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: yield* ids.allocate.command({
              fixtureName: "thread-fork-native-prior-turn",
              commandName: "source-message-merge-back",
            }),
            threadId: sourceThreadId,
            messageId: MessageId.make("message-thread-fork-native-prior-turn-merge-back"),
            text: mergeBackPrompt,
            attachments: [],
            modelSelection: CODEX_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          },
        ] satisfies ReadonlyArray<OrchestrationV2Command>;

        return {
          sourceThreadId,
          targetThreadId,
          firstRunId,
          forkRunId,
          commands,
        };
      }).pipe(Effect.provide(idAllocatorLayer), provideDeterministicTestRuntime);
      const expectedSummary = makeExpectedForkDeltaSummary({
        sourceThreadId: materialized.targetThreadId,
        targetThreadId: materialized.sourceThreadId,
        forkUserText: forkPrompt,
        forkAssistantText: findCompletedAgentMessageText({
          transcript: rawTranscript,
          threadId: forkNativeThreadId,
          turnId: forkRepeatNativeTurnId,
        }),
      });
      const providerMessageText = [
        "Context handoff (merge_back / fork_delta_summary):",
        expectedSummary,
        "",
        "User message:",
        mergeBackPrompt,
      ].join("\n");
      const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
        transcriptWithMergeBackContinuation({
          transcript: rawTranscript,
          providerMessageText,
          projectedUserText: mergeBackPrompt,
          assistantText: mergeBackAssistantText,
        }),
      );
      const cwd = yield* Effect.acquireRelease(makeCheckpointWorkspace, (directory) =>
        Effect.service(FileSystem.FileSystem).pipe(
          Effect.flatMap((fs) => fs.remove(directory, { recursive: true, force: true })),
          Effect.orDie,
        ),
      );

      const result = yield* runOrchestratorV2ProviderReplayScenario(
        {
          name: "thread_fork_native_prior_turn_merge_back/codex",
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
            { type: "dispatch", command: materialized.commands[6]!, await: true },
            { type: "dispatch", command: materialized.commands[7]!, await: true },
            { type: "await_thread_idle", threadId: materialized.sourceThreadId },
          ],
          projectionThreadIds: [materialized.sourceThreadId, materialized.targetThreadId],
          runtimePolicyOverride: { cwd, ...CODEX_READ_ONLY_NEVER_POLICY },
        },
        CodexOrchestratorReplayHarness,
      ).pipe(provideDeterministicTestRuntime);

      const sourceProjection = result.projections.get(materialized.sourceThreadId);
      const forkProjection = result.projections.get(materialized.targetThreadId);
      assert.isDefined(sourceProjection);
      assert.isDefined(forkProjection);

      assert.equal(
        sourceProjection.providerThreads[0]?.nativeThreadRef?.nativeId,
        sourceNativeThreadId,
        "merge-back should continue the original source provider thread",
      );
      assert.lengthOf(sourceProjection.runs, 3);
      assert.equal(
        sourceProjection.runs[2]?.contextHandoffId,
        sourceProjection.contextHandoffs[0]?.id,
      );
      assert.lengthOf(sourceProjection.contextHandoffs, 1);
      const handoff = sourceProjection.contextHandoffs[0]!;
      assert.equal(handoff.strategy, "fork_delta_summary");
      assert.equal(handoff.status, "ready");
      assert.equal(handoff.threadId, materialized.sourceThreadId);
      assert.equal(handoff.targetRunId, sourceProjection.runs[2]?.id);
      assert.deepEqual(handoff.coveredRunOrdinals, { from: 1, to: 1 });
      assert.include(handoff.summaryText, "Merge-back context from forked conversation.");
      assert.include(handoff.summaryText, "Repeat the user-visible conversation");
      assert.notInclude(
        handoff.summaryText,
        "fork boundary beta",
        "merge-back context should summarize only fork-local delta after the source point",
      );
      assert.equal(handoff.summaryText, expectedSummary);

      const mergeBackTransfers = sourceProjection.contextTransfers.filter(
        (transfer) => transfer.type === "merge_back",
      );
      assert.lengthOf(mergeBackTransfers, 2);
      const supersededTransfer = mergeBackTransfers.find(
        (transfer) => transfer.status === "superseded",
      );
      const mergeBackTransfer = mergeBackTransfers.find(
        (transfer) => transfer.status === "consumed",
      );
      assert.isDefined(supersededTransfer);
      assert.isDefined(mergeBackTransfer);
      assert.include(
        supersededTransfer.error ?? "",
        mergeBackTransfer.id,
        "newer merge-back preparation should supersede the previous pending transfer",
      );
      assert.equal(mergeBackTransfer.sourceThreadId, materialized.targetThreadId);
      assert.equal(mergeBackTransfer.targetThreadId, materialized.sourceThreadId);
      assert.equal(mergeBackTransfer.sourcePoint.runId, materialized.forkRunId);
      assert.equal(mergeBackTransfer.basePoint?.runId, materialized.firstRunId);
      assert.equal(mergeBackTransfer.status, "consumed");
      assert.equal(mergeBackTransfer.targetRunId, sourceProjection.runs[2]?.id);
      assert.equal(mergeBackTransfer.resolution?.strategy, "fork_delta_context");
      assert.equal(
        mergeBackTransfer.resolution?.strategy === "fork_delta_context"
          ? mergeBackTransfer.resolution.contextHandoffId
          : null,
        handoff.id,
      );

      const mergeBackRunItems = sourceProjection.turnItems.filter(
        (item) => item.runId === sourceProjection.runs[2]?.id,
      );
      assert.deepEqual(
        mergeBackRunItems.map((item) => item.type),
        ["handoff", "user_message", "assistant_message", "checkpoint"],
      );
      const handoffItem = mergeBackRunItems[0];
      assert.equal(handoffItem?.type, "handoff");
      assert.equal(
        handoffItem?.type === "handoff" ? handoffItem.contextHandoffId : null,
        handoff.id,
      );
      assert.equal(handoffItem?.ordinal, 299);
      const mergeUserItem = mergeBackRunItems.find((item) => item.type === "user_message");
      assert.equal(
        mergeUserItem?.type === "user_message" ? mergeUserItem.text : null,
        mergeBackPrompt,
      );
      assert.notInclude(
        sourceProjection.turnItems
          .filter((item) => item.type === "user_message")
          .map((item) => item.text)
          .join("\n"),
        "Context handoff",
        "context handoff text should be provider input only, not projected user-visible message text",
      );
      assert.include(
        sourceProjection.turnItems
          .filter((item) => item.type === "assistant_message")
          .map((item) => item.text)
          .join("\n"),
        mergeBackAssistantText,
      );

      const visibleTypes = sourceProjection.visibleTurnItems.map((row) => row.item.type);
      assert.includeMembers(visibleTypes, ["handoff", "user_message", "assistant_message"]);
      const sourceShell = result.shellSnapshot.threads.find(
        (thread) => thread.id === materialized.sourceThreadId,
      );
      assert.isDefined(sourceShell);
      assert.equal(sourceShell.visibleItemCount, sourceProjection.visibleTurnItems.length);

      assert.include(
        forkProjection.turnItems
          .filter((item) => item.type === "user_message")
          .map((item) => item.text)
          .join("\n"),
        forkPrompt,
        "merge-back should not remove fork-local history",
      );
      assert.equal(forkProjection.contextTransfers[0]?.resolution?.strategy, "native_fork");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
});
