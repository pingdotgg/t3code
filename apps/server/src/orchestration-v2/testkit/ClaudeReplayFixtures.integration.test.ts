import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { classifyClaudeNativeTool } from "../Adapters/ClaudeAdapterV2.ts";
import {
  ClaudeOrchestratorReplayHarness,
  recordClaudeAgentSdkReplayTranscript,
  replayClaudeAgentSdkTranscript,
} from "../Adapters/ClaudeAdapterV2.testkit.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "./fixtures/index.ts";
import {
  MULTI_TURN_FIRST_PROMPT,
  MULTI_TURN_SECOND_PROMPT,
  SIMPLE_PROMPT,
  THREAD_FORK_NATIVE_CONTINUE_FORK_MARKER,
  THREAD_FORK_NATIVE_CONTINUE_RECALL,
  THREAD_FORK_NATIVE_CONTINUE_SOURCE_MARKER,
  THREAD_MERGE_BACK_FORK_MARKER,
  THREAD_MERGE_BACK_RECALL,
  THREAD_MERGE_BACK_SIBLINGS_FIRST_MARKER,
  THREAD_MERGE_BACK_SIBLINGS_RECALL,
  THREAD_MERGE_BACK_SIBLINGS_SECOND_MARKER,
  THREAD_MERGE_BACK_SIBLINGS_SOURCE_MARKER,
  THREAD_MERGE_BACK_SOURCE_MARKER,
} from "./fixtures/shared.ts";
import { checkpointWorkspace } from "./ReplayFixtureWorkspace.ts";
import { decodeProviderReplayNdjson } from "./ReplayTranscriptNdjson.ts";

const readTranscript = Effect.fn("readClaudeReplayFixture")(function* (file: URL) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(decodeURIComponent(file.pathname));
  return yield* decodeProviderReplayNdjson(text);
}, Effect.provide(NodeServices.layer));

function claudeFixture(name: string) {
  const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find((entry) => entry.name === name);
  const provider = fixture?.providers.find((entry) => entry.driver === "claudeAgent");
  if (fixture === undefined || provider === undefined) {
    throw new Error(`Missing ${name}/claudeAgent replay fixture.`);
  }
  return { fixture, provider };
}

function readClaudeTranscriptFixture(path: string) {
  return readTranscript(new URL(`./fixtures/${path}/claude_transcript.ndjson`, import.meta.url));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function metadataString(transcript: ProviderReplayTranscript, key: string): string {
  const value = transcript.metadata?.[key];
  if (typeof value !== "string") {
    throw new Error(`${transcript.scenario} metadata.${key} must be a string.`);
  }
  return value;
}

function metadataStringArray(
  transcript: ProviderReplayTranscript,
  key: string,
): ReadonlyArray<string> {
  const value = transcript.metadata?.[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${transcript.scenario} metadata.${key} must be a string array.`);
  }
  return value;
}

type FramedReplayEntry = Extract<
  ProviderReplayTranscript["entries"][number],
  { readonly frame: unknown }
>;

function frameRecord(entry: FramedReplayEntry): Record<string, unknown> {
  if (!isRecord(entry.frame)) {
    throw new Error("Replay entry frame must be an object.");
  }
  return entry.frame;
}

function findEntryFrame(
  transcript: ProviderReplayTranscript,
  label: string,
): Record<string, unknown> {
  const entry = transcript.entries.find(
    (candidate): candidate is FramedReplayEntry =>
      "label" in candidate && candidate.label === label && "frame" in candidate,
  );
  assert.isDefined(entry, `${transcript.scenario} must include replay entry ${label}`);
  return frameRecord(entry);
}

function successResultTexts(transcript: ProviderReplayTranscript): ReadonlyArray<string> {
  return transcript.entries.flatMap((entry) => {
    if (entry.type !== "emit_inbound" || !isRecord(entry.frame)) {
      return [];
    }
    if (entry.frame.type !== "result" || entry.frame.subtype !== "success") {
      return [];
    }
    return typeof entry.frame.result === "string" ? [entry.frame.result] : [];
  });
}

function claudeToolUseNamesFromTranscript(
  transcript: ProviderReplayTranscript,
): ReadonlyArray<string> {
  return transcript.entries.flatMap((entry) => {
    if (
      entry.type !== "emit_inbound" ||
      !isRecord(entry.frame) ||
      entry.frame.type !== "assistant"
    ) {
      return [];
    }

    const message = entry.frame.message;
    const content = isRecord(message) ? message.content : undefined;
    if (!Array.isArray(content)) {
      return [];
    }

    return content.flatMap((part) =>
      isRecord(part) &&
      typeof part.id === "string" &&
      typeof part.name === "string" &&
      "input" in part
        ? [part.name]
        : [],
    );
  });
}

describe("Claude Agent SDK replay fixtures", () => {
  it.effect("classifies every Claude fixture tool use through the native tool table", () =>
    Effect.gen(function* () {
      const unknownToolNames = new Set<string>();
      const seenToolNames = new Set<string>();

      for (const fixture of ORCHESTRATOR_REPLAY_FIXTURES) {
        for (const provider of fixture.providers) {
          if (provider.driver !== "claudeAgent") {
            continue;
          }

          const transcript = yield* readTranscript(provider.transcriptFile);
          for (const toolName of claudeToolUseNamesFromTranscript(transcript)) {
            seenToolNames.add(toolName);
            const classification = classifyClaudeNativeTool(toolName);
            if (!classification.known) {
              unknownToolNames.add(`${fixture.name}:${toolName}`);
            }
          }
        }
      }

      assert.isAtLeast(seenToolNames.size, 1, "expected Claude fixtures to contain tool uses");
      assert.deepEqual([...unknownToolNames], []);
    }),
  );

  it.effect("keeps unregistered native conversation-state transcripts reviewable", () =>
    Effect.gen(function* () {
      const rollback = yield* readClaudeTranscriptFixture("thread_rollback");
      assert.equal(rollback.metadata?.queryMode, "resume_at_cursor");
      const rollbackCursor = metadataString(rollback, "resumeSessionAt");
      const rollbackResumeFrame = findEntryFrame(rollback, "query.open:resume_at_cursor");
      const rollbackResumeOptions = rollbackResumeFrame.options;
      if (!isRecord(rollbackResumeOptions)) {
        throw new Error("Rollback resume query.open options must be an object.");
      }
      assert.equal(rollbackResumeOptions.resumeSessionAt, rollbackCursor);
      const rollbackFinalText = successResultTexts(rollback).at(-1) ?? "";
      assert.include(rollbackFinalText, "rollback fixture first turn complete");
      assert.notInclude(rollbackFinalText, "rollback fixture second turn complete");

      const latestFork = yield* readClaudeTranscriptFixture("thread_fork_native");
      assert.equal(latestFork.metadata?.queryMode, "fork_session");
      const latestForkedSessionId = metadataString(latestFork, "forkedNativeSessionId");
      const latestForkedFrame = findEntryFrame(latestFork, "session.forked");
      assert.equal(latestForkedFrame.sessionId, latestForkedSessionId);

      const priorFork = yield* readClaudeTranscriptFixture("thread_fork_native_prior_turn");
      assert.equal(priorFork.metadata?.queryMode, "fork_session_prior_turn");
      const priorForkCursor = metadataString(priorFork, "forkUpToMessageId");
      const priorForkFrame = findEntryFrame(priorFork, "session.fork");
      const priorForkOptions = priorForkFrame.options;
      if (!isRecord(priorForkOptions)) {
        throw new Error("Prior-turn fork options must be an object.");
      }
      assert.equal(priorForkOptions.upToMessageId, priorForkCursor);
      const priorForkFinalText = successResultTexts(priorFork).at(-1) ?? "";
      assert.include(priorForkFinalText, "fork boundary alpha");
      assert.notInclude(priorForkFinalText, "fork boundary beta");

      const continuedFork = yield* readClaudeTranscriptFixture("thread_fork_native_continue");
      assert.equal(continuedFork.metadata?.queryMode, "fork_session_continue");
      const continuedForkSessionId = metadataString(continuedFork, "forkedNativeSessionId");
      const continuedForkOpenFrame = findEntryFrame(continuedFork, "query.open:fork");
      const continuedForkOptions = continuedForkOpenFrame.options;
      if (!isRecord(continuedForkOptions)) {
        throw new Error("Continued fork query.open options must be an object.");
      }
      assert.equal(continuedForkOptions.resume, continuedForkSessionId);
      const continuedForkResults = successResultTexts(continuedFork);
      assert.deepEqual(continuedForkResults.slice(0, 2), [
        "source marker stored",
        "fork marker stored",
      ]);
      assert.equal(
        continuedForkResults.at(-1)?.replace(/\s*\|\s*/u, "|"),
        THREAD_FORK_NATIVE_CONTINUE_RECALL,
      );
      const recallPromptFrame = findEntryFrame(continuedFork, "prompt.offer:3");
      const recallMessage = recallPromptFrame.message;
      const recallMessageBody = isRecord(recallMessage) ? recallMessage.message : undefined;
      const recallPrompt =
        isRecord(recallMessageBody) && typeof recallMessageBody.content === "string"
          ? recallMessageBody.content
          : "";
      assert.notInclude(recallPrompt, THREAD_FORK_NATIVE_CONTINUE_SOURCE_MARKER);
      assert.notInclude(recallPrompt, THREAD_FORK_NATIVE_CONTINUE_FORK_MARKER);

      const siblingForks = yield* readClaudeTranscriptFixture("thread_fork_native_siblings");
      assert.equal(siblingForks.metadata?.queryMode, "fork_session_siblings");
      const siblingSessionIds = metadataStringArray(siblingForks, "forkedNativeSessionIds");
      assert.lengthOf(siblingSessionIds, 2);
      assert.notEqual(siblingSessionIds[0], siblingSessionIds[1]);
      const siblingResults = successResultTexts(siblingForks).map((text) =>
        text.replace(/\s*\|\s*/u, "|"),
      );
      assert.deepEqual(siblingResults, [
        "sibling source stored",
        "sibling-source-8R3D|sibling-first-5L2P",
        "sibling-source-8R3D|sibling-second-9N6C",
      ]);
      assert.notInclude(siblingResults[1] ?? "", "sibling-second-9N6C");
      assert.notInclude(siblingResults[2] ?? "", "sibling-first-5L2P");

      const mergeBack = yield* readClaudeTranscriptFixture("thread_merge_back_continue");
      assert.equal(mergeBack.metadata?.queryMode, "fork_session_merge_back");
      const mergeBackSourceSessionId = metadataString(mergeBack, "nativeSessionId");
      const mergeBackContinuationFrame = findEntryFrame(
        mergeBack,
        "query.open:source-continuation",
      );
      const mergeBackContinuationOptions = mergeBackContinuationFrame.options;
      if (!isRecord(mergeBackContinuationOptions)) {
        throw new Error("Merge-back source continuation options must be an object.");
      }
      assert.equal(mergeBackContinuationOptions.resume, mergeBackSourceSessionId);
      const mergeBackRecallFrame = findEntryFrame(mergeBack, "prompt.offer:4");
      const mergeBackRecallMessage = mergeBackRecallFrame.message;
      const mergeBackRecallBody = isRecord(mergeBackRecallMessage)
        ? mergeBackRecallMessage.message
        : undefined;
      const mergeBackRecallPrompt =
        isRecord(mergeBackRecallBody) && typeof mergeBackRecallBody.content === "string"
          ? mergeBackRecallBody.content
          : "";
      assert.notInclude(mergeBackRecallPrompt, THREAD_MERGE_BACK_SOURCE_MARKER);
      assert.notInclude(mergeBackRecallPrompt, THREAD_MERGE_BACK_FORK_MARKER);
      assert.equal(
        successResultTexts(mergeBack)
          .at(-1)
          ?.replace(/\s*\|\s*/gu, "|"),
        THREAD_MERGE_BACK_RECALL,
      );

      const siblingMergeBack = yield* readClaudeTranscriptFixture("thread_merge_back_siblings");
      assert.equal(siblingMergeBack.metadata?.queryMode, "fork_session_merge_back_siblings");
      const siblingMergeSessionIds = metadataStringArray(
        siblingMergeBack,
        "forkedNativeSessionIds",
      );
      assert.lengthOf(siblingMergeSessionIds, 2);
      assert.notEqual(siblingMergeSessionIds[0], siblingMergeSessionIds[1]);
      const siblingMergeRecallFrame = findEntryFrame(siblingMergeBack, "prompt.offer:6");
      const siblingMergeRecallMessage = siblingMergeRecallFrame.message;
      const siblingMergeRecallBody = isRecord(siblingMergeRecallMessage)
        ? siblingMergeRecallMessage.message
        : undefined;
      const siblingMergeRecallPrompt =
        isRecord(siblingMergeRecallBody) && typeof siblingMergeRecallBody.content === "string"
          ? siblingMergeRecallBody.content
          : "";
      assert.notInclude(siblingMergeRecallPrompt, THREAD_MERGE_BACK_SIBLINGS_SOURCE_MARKER);
      assert.notInclude(siblingMergeRecallPrompt, THREAD_MERGE_BACK_SIBLINGS_FIRST_MARKER);
      assert.notInclude(siblingMergeRecallPrompt, THREAD_MERGE_BACK_SIBLINGS_SECOND_MARKER);
      assert.equal(
        successResultTexts(siblingMergeBack)
          .at(-1)
          ?.replace(/\s*\|\s*/gu, "|"),
        THREAD_MERGE_BACK_SIBLINGS_RECALL,
      );

      const forkLocalRollback = yield* readClaudeTranscriptFixture(
        "thread_fork_native_fork_local_rollback",
      );
      assert.equal(forkLocalRollback.metadata?.queryMode, "fork_session_resume_at_fork_cursor");
      const forkLocalRollbackCursor = metadataString(forkLocalRollback, "resumeSessionAt");
      const forkLocalRollbackFrame = findEntryFrame(
        forkLocalRollback,
        "query.open:fork-resume-at-cursor",
      );
      const forkLocalRollbackOptions = forkLocalRollbackFrame.options;
      if (!isRecord(forkLocalRollbackOptions)) {
        throw new Error("Fork-local rollback resume query.open options must be an object.");
      }
      assert.equal(forkLocalRollbackOptions.resumeSessionAt, forkLocalRollbackCursor);
      const forkLocalRollbackFinalText = successResultTexts(forkLocalRollback).at(-1) ?? "";
      assert.include(forkLocalRollbackFinalText, "fork local source alpha");
      assert.include(forkLocalRollbackFinalText, "fork local first");
      assert.notInclude(forkLocalRollbackFinalText, "fork local second");
    }),
  );

  it.skipIf(process.env.T3_RECORD_CLAUDE_AGENT_SDK_FIXTURE !== "1")(
    "records simple from real Claude Code query() output",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { fixture, provider } = claudeFixture("simple");

          const workspace = yield* checkpointWorkspace("claude-simple-record");
          const transcript = yield* Effect.promise(() =>
            recordClaudeAgentSdkReplayTranscript({
              scenario: fixture.name,
              prompts: [SIMPLE_PROMPT],
              modelSelection: provider.modelSelection,
              cwd: workspace,
            }),
          );

          assert.equal(transcript.provider, "claudeAgent");
          assert.equal(transcript.protocol, "claude-agent-sdk.query");
          assert.isAtLeast(transcript.entries.length, 3);
        }),
      ),
  );

  it.effect("replays simple as typed Claude Agent SDK query messages", () =>
    Effect.gen(function* () {
      const { provider } = claudeFixture("simple");

      const rawTranscript = yield* readTranscript(provider.transcriptFile);
      const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(rawTranscript);

      const messages = yield* Effect.promise(() =>
        replayClaudeAgentSdkTranscript({
          transcript,
          prompts: [SIMPLE_PROMPT],
          modelSelection: provider.modelSelection,
        }),
      );

      assert.include(
        messages
          .filter((message) => message.type === "assistant")
          .flatMap((message) =>
            message.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
          )
          .join(""),
        "fixture simple ok",
      );
    }),
  );

  it.effect("replays multi_turn as typed Claude Agent SDK query messages", () =>
    Effect.gen(function* () {
      const { provider } = claudeFixture("multi_turn");

      const rawTranscript = yield* readTranscript(provider.transcriptFile);
      const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(rawTranscript);

      const messages = yield* Effect.promise(() =>
        replayClaudeAgentSdkTranscript({
          transcript,
          prompts: [MULTI_TURN_FIRST_PROMPT, MULTI_TURN_SECOND_PROMPT],
          modelSelection: provider.modelSelection,
        }),
      );

      const assistantText = messages
        .filter((message) => message.type === "assistant")
        .flatMap((message) =>
          message.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
        )
        .join("\n");
      assert.include(assistantText, "first fixture turn complete");
      assert.include(assistantText, "second fixture turn complete");
    }),
  );
});
