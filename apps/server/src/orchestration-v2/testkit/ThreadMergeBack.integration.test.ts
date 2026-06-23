import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  type ProviderReplayTranscript,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { ClaudeOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import { CodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import {
  THREAD_MERGE_BACK_FORK_PROMPT,
  THREAD_MERGE_BACK_HANDOFF_PROMPT,
  THREAD_MERGE_BACK_RECALL,
  THREAD_MERGE_BACK_RECALL_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_FIRST_FORK_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_FIRST_HANDOFF_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_RECALL,
  THREAD_MERGE_BACK_SIBLINGS_RECALL_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_SECOND_FORK_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_SECOND_HANDOFF_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_SOURCE_PROMPT,
  THREAD_MERGE_BACK_SOURCE_PROMPT,
} from "./fixtures/shared.ts";
import { runOrchestratorV2ProviderReplayScenario } from "./ProviderReplayHarness.ts";
import { makeCheckpointWorkspace } from "./ReplayFixtureWorkspace.ts";
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
const MERGE_BACK_USER_TEXT =
  "Retain the transferred fork marker for later. Respond with exactly: merge delta stored";
const FIRST_SIBLING_MERGE_USER_TEXT =
  "Retain the first transferred marker for later. Respond with exactly: first merge delta stored";
const SECOND_SIBLING_MERGE_USER_TEXT =
  "Retain the second transferred marker for later. Respond with exactly: second merge delta stored";

interface ProviderVariant {
  readonly driver: ProviderDriverKind;
  readonly modelSelection: ModelSelection;
}

const PROVIDERS: ReadonlyArray<ProviderVariant> = [
  {
    driver: ProviderDriverKind.make("codex"),
    modelSelection: CODEX_MODEL_SELECTION,
  },
  {
    driver: ProviderDriverKind.make("claudeAgent"),
    modelSelection: CLAUDE_MODEL_SELECTION,
  },
];

function transcriptPath(scenario: string, driver: ProviderDriverKind): string {
  const fileName = driver === "codex" ? "codex_transcript.ndjson" : "claude_transcript.ndjson";
  return `${import.meta.dirname}/fixtures/${scenario}/${fileName}`;
}

function readTranscript(scenario: string, driver: ProviderDriverKind) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(transcriptPath(scenario, driver));
    return yield* decodeProviderReplayNdjson(text);
  });
}

function compactExpectedText(text: string, maxLength = 240): string {
  const compacted = text.replace(/\s+/gu, " ").trim();
  return compacted.length <= maxLength ? compacted : `${compacted.slice(0, maxLength - 3)}...`;
}

function forkDeltaSummary(input: {
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
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

function providerMessage(summary: string, userText: string): string {
  return [
    "Context handoff (merge_back / fork_delta_summary):",
    summary,
    "",
    "User message:",
    userText,
  ].join("\n");
}

function replaceExactString(value: unknown, from: string, to: string): unknown {
  if (value === from) {
    return to;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => replaceExactString(entry, from, to));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, replaceExactString(entry, from, to)]),
  );
}

function parameterizeHandoffs(
  transcript: ProviderReplayTranscript,
  replacements: ReadonlyArray<readonly [recorded: string, generated: string]>,
): ProviderReplayTranscript {
  return replacements.reduce(
    (current, [recorded, generated]) =>
      replaceExactString(current, recorded, generated) as ProviderReplayTranscript,
    transcript,
  );
}

function nativeSourceThreadId(transcript: ProviderReplayTranscript): string {
  if (transcript.provider === "claudeAgent") {
    const value = transcript.metadata?.nativeSessionId;
    if (typeof value !== "string") {
      throw new Error(`${transcript.scenario} is missing metadata.nativeSessionId.`);
    }
    return value;
  }
  for (const entry of transcript.entries) {
    if (entry.type !== "emit_inbound") {
      continue;
    }
    const frame = entry.frame as {
      readonly method?: unknown;
      readonly params?: { readonly thread?: { readonly id?: unknown } };
    };
    if (frame.method === "thread/started" && typeof frame.params?.thread?.id === "string") {
      return frame.params.thread.id;
    }
  }
  throw new Error(`${transcript.scenario} is missing the source native thread id.`);
}

function visibleConversationText(projection: OrchestrationV2ThreadProjection): string {
  return projection.visibleTurnItems
    .flatMap(({ item }) =>
      item.type === "user_message" || item.type === "assistant_message" ? [item.text] : [],
    )
    .join("\n");
}

function normalizePipeSpacing(text: string): string {
  return text.replace(/\s*\|\s*/gu, "|");
}

function makeCreateCommand(input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
}): OrchestrationV2Command {
  return {
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: input.commandId,
    threadId: input.threadId,
    projectId: input.projectId,
    title: "Merge-back source",
    modelSelection: input.modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  };
}

describe("orchestration V2 merge-back provider replay", () => {
  for (const variant of PROVIDERS) {
    it.effect(`merges one fork delta back into the original ${variant.driver} thread`, () =>
      Effect.gen(function* () {
        const rawTranscript = yield* readTranscript("thread_merge_back_continue", variant.driver);
        const materialized = yield* Effect.gen(function* () {
          const ids = yield* IdAllocatorV2;
          const projectId = yield* ids.allocate.project({
            fixtureName: `thread-merge-back-${variant.driver}`,
          });
          const sourceThreadId = yield* ids.allocate.thread({
            fixtureName: `thread-merge-back-${variant.driver}-source`,
            projectId,
          });
          const forkThreadId = ThreadId.make(`thread-merge-back-${variant.driver}-fork`);
          const forkRunId = ids.derive.run({ threadId: forkThreadId, ordinal: 1 });
          const commands = [
            makeCreateCommand({
              commandId: yield* ids.allocate.command({
                fixtureName: `thread-merge-back-${variant.driver}`,
                commandName: "create",
              }),
              threadId: sourceThreadId,
              projectId,
              modelSelection: variant.modelSelection,
            }),
            {
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: yield* ids.allocate.command({
                fixtureName: `thread-merge-back-${variant.driver}`,
                commandName: "source",
              }),
              threadId: sourceThreadId,
              messageId: MessageId.make(`message-merge-source-${variant.driver}`),
              text: THREAD_MERGE_BACK_SOURCE_PROMPT,
              attachments: [],
              modelSelection: variant.modelSelection,
              dispatchMode: { type: "start_immediately" },
            },
            {
              type: "thread.fork",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command-merge-fork-${variant.driver}`),
              sourceThreadId,
              targetThreadId: forkThreadId,
              sourcePoint: { type: "latest_stable" },
              title: "Merge-back fork",
            },
            {
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: yield* ids.allocate.command({
                fixtureName: `thread-merge-back-${variant.driver}`,
                commandName: "fork-delta",
              }),
              threadId: forkThreadId,
              messageId: MessageId.make(`message-merge-fork-${variant.driver}`),
              text: THREAD_MERGE_BACK_FORK_PROMPT,
              attachments: [],
              modelSelection: variant.modelSelection,
              dispatchMode: { type: "start_immediately" },
            },
            {
              type: "thread.merge_back",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command-merge-back-${variant.driver}`),
              sourceThreadId: forkThreadId,
              targetThreadId: sourceThreadId,
              sourcePoint: { type: "run", runId: forkRunId },
            },
            {
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: yield* ids.allocate.command({
                fixtureName: `thread-merge-back-${variant.driver}`,
                commandName: "consume-merge",
              }),
              threadId: sourceThreadId,
              messageId: MessageId.make(`message-consume-merge-${variant.driver}`),
              text: MERGE_BACK_USER_TEXT,
              attachments: [],
              modelSelection: variant.modelSelection,
              dispatchMode: { type: "start_immediately" },
            },
            {
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: yield* ids.allocate.command({
                fixtureName: `thread-merge-back-${variant.driver}`,
                commandName: "recall",
              }),
              threadId: sourceThreadId,
              messageId: MessageId.make(`message-merge-recall-${variant.driver}`),
              text: THREAD_MERGE_BACK_RECALL_PROMPT,
              attachments: [],
              modelSelection: variant.modelSelection,
              dispatchMode: { type: "start_immediately" },
            },
          ] satisfies ReadonlyArray<OrchestrationV2Command>;
          return { commands, sourceThreadId, forkThreadId, forkRunId };
        }).pipe(Effect.provide(idAllocatorLayer), provideDeterministicTestRuntime);
        const summary = forkDeltaSummary({
          sourceThreadId: materialized.forkThreadId,
          targetThreadId: materialized.sourceThreadId,
          forkUserText: THREAD_MERGE_BACK_FORK_PROMPT,
          forkAssistantText: "merge fork stored",
        });
        const generatedProviderMessage = providerMessage(summary, MERGE_BACK_USER_TEXT);
        const parameterizedTranscript = parameterizeHandoffs(rawTranscript, [
          [THREAD_MERGE_BACK_HANDOFF_PROMPT, generatedProviderMessage],
        ]);
        const cwd = yield* Effect.acquireRelease(
          Effect.promise(() => makeCheckpointWorkspace(`merge-back-${variant.driver}`)),
          (directory) =>
            Effect.service(FileSystem.FileSystem).pipe(
              Effect.flatMap((fs) => fs.remove(directory, { recursive: true, force: true })),
              Effect.orDie,
            ),
        );
        const scenario = {
          name: `thread_merge_back_continue/${variant.driver}`,
          commands: materialized.commands,
          steps: [
            { type: "dispatch" as const, command: materialized.commands[0]!, await: true },
            { type: "advance_clock" as const, duration: "1 millis" as const },
            { type: "dispatch" as const, command: materialized.commands[1]!, await: true },
            { type: "await_thread_idle" as const, threadId: materialized.sourceThreadId },
            { type: "dispatch" as const, command: materialized.commands[2]!, await: true },
            { type: "dispatch" as const, command: materialized.commands[3]!, await: true },
            { type: "await_thread_idle" as const, threadId: materialized.forkThreadId },
            { type: "dispatch" as const, command: materialized.commands[4]!, await: true },
            { type: "dispatch" as const, command: materialized.commands[5]!, await: true },
            { type: "await_thread_idle" as const, threadId: materialized.sourceThreadId },
            { type: "dispatch" as const, command: materialized.commands[6]!, await: true },
            { type: "await_thread_idle" as const, threadId: materialized.sourceThreadId },
          ],
          projectionThreadIds: [materialized.sourceThreadId, materialized.forkThreadId],
          runtimePolicyOverride: { cwd },
        };
        const result =
          variant.driver === "codex"
            ? yield* runOrchestratorV2ProviderReplayScenario(
                {
                  ...scenario,
                  transcript: yield* CodexOrchestratorReplayHarness.decodeTranscript(
                    materializeReplayTranscriptWorkspace(parameterizedTranscript, cwd),
                  ),
                },
                CodexOrchestratorReplayHarness,
              ).pipe(provideDeterministicTestRuntime)
            : yield* runOrchestratorV2ProviderReplayScenario(
                {
                  ...scenario,
                  transcript:
                    yield* ClaudeOrchestratorReplayHarness.decodeTranscript(
                      parameterizedTranscript,
                    ),
                },
                ClaudeOrchestratorReplayHarness,
              ).pipe(provideDeterministicTestRuntime);

        const source = result.projections.get(materialized.sourceThreadId);
        const fork = result.projections.get(materialized.forkThreadId);
        assert.isDefined(source);
        assert.isDefined(fork);
        assert.equal(
          source.providerThreads[0]?.nativeThreadRef?.nativeId,
          nativeSourceThreadId(rawTranscript),
        );
        assert.lengthOf(source.contextHandoffs, 1);
        assert.equal(source.contextHandoffs[0]?.summaryText, summary);
        assert.equal(source.contextHandoffs[0]?.strategy, "fork_delta_summary");
        const mergeTransfer = source.contextTransfers.find(
          (transfer) => transfer.type === "merge_back",
        );
        assert.isDefined(mergeTransfer);
        assert.equal(mergeTransfer.status, "consumed");
        assert.equal(mergeTransfer.sourcePoint.runId, materialized.forkRunId);
        assert.equal(mergeTransfer.resolution?.strategy, "fork_delta_context");
        assert.include(
          normalizePipeSpacing(visibleConversationText(source)),
          THREAD_MERGE_BACK_RECALL,
        );
        assert.notInclude(visibleConversationText(source), "Context handoff (");
        assert.include(visibleConversationText(fork), "merge fork stored");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.effect(`merges two sibling fork deltas into the original ${variant.driver} thread`, () =>
      Effect.gen(function* () {
        const rawTranscript = yield* readTranscript("thread_merge_back_siblings", variant.driver);
        const materialized = yield* Effect.gen(function* () {
          const ids = yield* IdAllocatorV2;
          const fixtureName = `thread-merge-back-siblings-${variant.driver}`;
          const projectId = yield* ids.allocate.project({ fixtureName });
          const sourceThreadId = yield* ids.allocate.thread({
            fixtureName: `${fixtureName}-source`,
            projectId,
          });
          const firstForkThreadId = ThreadId.make(`${fixtureName}-first-fork`);
          const secondForkThreadId = ThreadId.make(`${fixtureName}-second-fork`);
          const firstForkRunId = ids.derive.run({ threadId: firstForkThreadId, ordinal: 1 });
          const secondForkRunId = ids.derive.run({ threadId: secondForkThreadId, ordinal: 1 });
          const commandId = (commandName: string) =>
            ids.allocate.command({ fixtureName, commandName });
          const commands = [
            makeCreateCommand({
              commandId: yield* commandId("create"),
              threadId: sourceThreadId,
              projectId,
              modelSelection: variant.modelSelection,
            }),
            {
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: yield* commandId("source"),
              threadId: sourceThreadId,
              messageId: MessageId.make(`message-${fixtureName}-source`),
              text: THREAD_MERGE_BACK_SIBLINGS_SOURCE_PROMPT,
              attachments: [],
              modelSelection: variant.modelSelection,
              dispatchMode: { type: "start_immediately" },
            },
            {
              type: "thread.fork",
              createdBy: "user",
              creationSource: "web",
              commandId: yield* commandId("first-fork"),
              sourceThreadId,
              targetThreadId: firstForkThreadId,
              sourcePoint: { type: "latest_stable" },
              title: "First merge-back sibling",
            },
            {
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: yield* commandId("first-fork-delta"),
              threadId: firstForkThreadId,
              messageId: MessageId.make(`message-${fixtureName}-first-fork`),
              text: THREAD_MERGE_BACK_SIBLINGS_FIRST_FORK_PROMPT,
              attachments: [],
              modelSelection: variant.modelSelection,
              dispatchMode: { type: "start_immediately" },
            },
            {
              type: "thread.fork",
              createdBy: "user",
              creationSource: "web",
              commandId: yield* commandId("second-fork"),
              sourceThreadId,
              targetThreadId: secondForkThreadId,
              sourcePoint: { type: "latest_stable" },
              title: "Second merge-back sibling",
            },
            {
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: yield* commandId("second-fork-delta"),
              threadId: secondForkThreadId,
              messageId: MessageId.make(`message-${fixtureName}-second-fork`),
              text: THREAD_MERGE_BACK_SIBLINGS_SECOND_FORK_PROMPT,
              attachments: [],
              modelSelection: variant.modelSelection,
              dispatchMode: { type: "start_immediately" },
            },
            {
              type: "thread.merge_back",
              createdBy: "user",
              creationSource: "web",
              commandId: yield* commandId("merge-first"),
              sourceThreadId: firstForkThreadId,
              targetThreadId: sourceThreadId,
              sourcePoint: { type: "run", runId: firstForkRunId },
            },
            {
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: yield* commandId("consume-first"),
              threadId: sourceThreadId,
              messageId: MessageId.make(`message-${fixtureName}-consume-first`),
              text: FIRST_SIBLING_MERGE_USER_TEXT,
              attachments: [],
              modelSelection: variant.modelSelection,
              dispatchMode: { type: "start_immediately" },
            },
            {
              type: "thread.merge_back",
              createdBy: "user",
              creationSource: "web",
              commandId: yield* commandId("merge-second"),
              sourceThreadId: secondForkThreadId,
              targetThreadId: sourceThreadId,
              sourcePoint: { type: "run", runId: secondForkRunId },
            },
            {
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: yield* commandId("consume-second"),
              threadId: sourceThreadId,
              messageId: MessageId.make(`message-${fixtureName}-consume-second`),
              text: SECOND_SIBLING_MERGE_USER_TEXT,
              attachments: [],
              modelSelection: variant.modelSelection,
              dispatchMode: { type: "start_immediately" },
            },
            {
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: yield* commandId("recall"),
              threadId: sourceThreadId,
              messageId: MessageId.make(`message-${fixtureName}-recall`),
              text: THREAD_MERGE_BACK_SIBLINGS_RECALL_PROMPT,
              attachments: [],
              modelSelection: variant.modelSelection,
              dispatchMode: { type: "start_immediately" },
            },
          ] satisfies ReadonlyArray<OrchestrationV2Command>;
          return {
            commands,
            sourceThreadId,
            firstForkThreadId,
            secondForkThreadId,
            firstForkRunId,
            secondForkRunId,
          };
        }).pipe(Effect.provide(idAllocatorLayer), provideDeterministicTestRuntime);
        const firstSummary = forkDeltaSummary({
          sourceThreadId: materialized.firstForkThreadId,
          targetThreadId: materialized.sourceThreadId,
          forkUserText: THREAD_MERGE_BACK_SIBLINGS_FIRST_FORK_PROMPT,
          forkAssistantText: "first merge sibling stored",
        });
        const secondSummary = forkDeltaSummary({
          sourceThreadId: materialized.secondForkThreadId,
          targetThreadId: materialized.sourceThreadId,
          forkUserText: THREAD_MERGE_BACK_SIBLINGS_SECOND_FORK_PROMPT,
          forkAssistantText: "second merge sibling stored",
        });
        const transcript = parameterizeHandoffs(rawTranscript, [
          [
            THREAD_MERGE_BACK_SIBLINGS_FIRST_HANDOFF_PROMPT,
            providerMessage(firstSummary, FIRST_SIBLING_MERGE_USER_TEXT),
          ],
          [
            THREAD_MERGE_BACK_SIBLINGS_SECOND_HANDOFF_PROMPT,
            providerMessage(secondSummary, SECOND_SIBLING_MERGE_USER_TEXT),
          ],
        ]);
        const cwd = yield* Effect.acquireRelease(
          Effect.promise(() => makeCheckpointWorkspace(`merge-back-siblings-${variant.driver}`)),
          (directory) =>
            Effect.service(FileSystem.FileSystem).pipe(
              Effect.flatMap((fs) => fs.remove(directory, { recursive: true, force: true })),
              Effect.orDie,
            ),
        );
        const steps = [
          { type: "dispatch" as const, command: materialized.commands[0]!, await: true },
          { type: "advance_clock" as const, duration: "1 millis" as const },
          { type: "dispatch" as const, command: materialized.commands[1]!, await: true },
          { type: "await_thread_idle" as const, threadId: materialized.sourceThreadId },
          { type: "dispatch" as const, command: materialized.commands[2]!, await: true },
          { type: "dispatch" as const, command: materialized.commands[3]!, await: true },
          { type: "await_thread_idle" as const, threadId: materialized.firstForkThreadId },
          { type: "dispatch" as const, command: materialized.commands[4]!, await: true },
          { type: "dispatch" as const, command: materialized.commands[5]!, await: true },
          { type: "await_thread_idle" as const, threadId: materialized.secondForkThreadId },
          { type: "dispatch" as const, command: materialized.commands[6]!, await: true },
          { type: "dispatch" as const, command: materialized.commands[7]!, await: true },
          { type: "await_thread_idle" as const, threadId: materialized.sourceThreadId },
          { type: "dispatch" as const, command: materialized.commands[8]!, await: true },
          { type: "dispatch" as const, command: materialized.commands[9]!, await: true },
          { type: "await_thread_idle" as const, threadId: materialized.sourceThreadId },
          { type: "dispatch" as const, command: materialized.commands[10]!, await: true },
          { type: "await_thread_idle" as const, threadId: materialized.sourceThreadId },
        ];
        const scenario = {
          name: `thread_merge_back_siblings/${variant.driver}`,
          commands: materialized.commands,
          steps,
          projectionThreadIds: [
            materialized.sourceThreadId,
            materialized.firstForkThreadId,
            materialized.secondForkThreadId,
          ],
          runtimePolicyOverride: { cwd },
        };
        const result =
          variant.driver === "codex"
            ? yield* runOrchestratorV2ProviderReplayScenario(
                {
                  ...scenario,
                  transcript: yield* CodexOrchestratorReplayHarness.decodeTranscript(
                    materializeReplayTranscriptWorkspace(transcript, cwd),
                  ),
                },
                CodexOrchestratorReplayHarness,
              ).pipe(provideDeterministicTestRuntime)
            : yield* runOrchestratorV2ProviderReplayScenario(
                {
                  ...scenario,
                  transcript: yield* ClaudeOrchestratorReplayHarness.decodeTranscript(transcript),
                },
                ClaudeOrchestratorReplayHarness,
              ).pipe(provideDeterministicTestRuntime);

        const source = result.projections.get(materialized.sourceThreadId);
        const firstFork = result.projections.get(materialized.firstForkThreadId);
        const secondFork = result.projections.get(materialized.secondForkThreadId);
        assert.isDefined(source);
        assert.isDefined(firstFork);
        assert.isDefined(secondFork);
        assert.equal(
          source.providerThreads[0]?.nativeThreadRef?.nativeId,
          nativeSourceThreadId(rawTranscript),
        );
        const firstForkNativeId = firstFork.providerThreads[0]?.nativeThreadRef?.nativeId;
        const secondForkNativeId = secondFork.providerThreads[0]?.nativeThreadRef?.nativeId;
        assert.isDefined(firstForkNativeId);
        assert.isDefined(secondForkNativeId);
        assert.notEqual(firstForkNativeId, secondForkNativeId);
        assert.notEqual(firstForkNativeId, source.providerThreads[0]?.nativeThreadRef?.nativeId);
        assert.notEqual(secondForkNativeId, source.providerThreads[0]?.nativeThreadRef?.nativeId);
        assert.deepEqual(
          source.contextHandoffs.map((handoff) => handoff.summaryText),
          [firstSummary, secondSummary],
        );
        const mergeTransfers = source.contextTransfers.filter(
          (transfer) => transfer.type === "merge_back",
        );
        assert.lengthOf(mergeTransfers, 2);
        assert.deepEqual(
          mergeTransfers.map((transfer) => transfer.status),
          ["consumed", "consumed"],
        );
        assert.deepEqual(
          mergeTransfers.map((transfer) => transfer.sourcePoint.runId),
          [materialized.firstForkRunId, materialized.secondForkRunId],
        );
        assert.include(
          normalizePipeSpacing(visibleConversationText(source)),
          THREAD_MERGE_BACK_SIBLINGS_RECALL,
        );
        assert.notInclude(visibleConversationText(source), "Context handoff (");
        assert.include(visibleConversationText(firstFork), "first merge sibling stored");
        assert.notInclude(visibleConversationText(firstFork), "second merge sibling stored");
        assert.include(visibleConversationText(secondFork), "second merge sibling stored");
        assert.notInclude(visibleConversationText(secondFork), "first merge sibling stored");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
});
