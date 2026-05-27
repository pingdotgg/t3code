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
} from "./fixtures/shared.ts";
import { makeCheckpointWorkspace } from "./ReplayFixtureWorkspace.ts";
import { decodeProviderReplayNdjson } from "./ReplayTranscriptNdjson.ts";

async function readTranscript(file: URL): Promise<ProviderReplayTranscript> {
  const text = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.readFileString(decodeURIComponent(file.pathname));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  return await Effect.runPromise(decodeProviderReplayNdjson(text));
}

async function removeDirectory(path: string): Promise<void> {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(path, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

function claudeFixture(name: string) {
  const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find((entry) => entry.name === name);
  const provider = fixture?.providers.find((entry) => entry.provider === "claudeAgent");
  if (fixture === undefined || provider === undefined) {
    throw new Error(`Missing ${name}/claudeAgent replay fixture.`);
  }
  return { fixture, provider };
}

async function readClaudeTranscriptFixture(path: string): Promise<ProviderReplayTranscript> {
  return await readTranscript(
    new URL(`./fixtures/${path}/claude_transcript.ndjson`, import.meta.url),
  );
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
  it("classifies every Claude fixture tool use through the native tool table", async () => {
    const unknownToolNames = new Set<string>();
    const seenToolNames = new Set<string>();

    for (const fixture of ORCHESTRATOR_REPLAY_FIXTURES) {
      for (const provider of fixture.providers) {
        if (provider.provider !== "claudeAgent") {
          continue;
        }

        const transcript = await readTranscript(provider.transcriptFile);
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
  });

  it("keeps unregistered native conversation-state transcripts reviewable", async () => {
    const rollback = await readClaudeTranscriptFixture("thread_rollback");
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

    const latestFork = await readClaudeTranscriptFixture("thread_fork_native");
    assert.equal(latestFork.metadata?.queryMode, "fork_session");
    const latestForkedSessionId = metadataString(latestFork, "forkedNativeSessionId");
    const latestForkedFrame = findEntryFrame(latestFork, "session.forked");
    assert.equal(latestForkedFrame.sessionId, latestForkedSessionId);

    const priorFork = await readClaudeTranscriptFixture("thread_fork_native_prior_turn");
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

    const forkLocalRollback = await readClaudeTranscriptFixture(
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
  });

  it.skipIf(process.env.T3_RECORD_CLAUDE_AGENT_SDK_FIXTURE !== "1")(
    "records simple from real Claude Code query() output",
    async () => {
      const { fixture, provider } = claudeFixture("simple");

      const checkpointWorkspace = await makeCheckpointWorkspace("claude-simple-record");
      try {
        const transcript = await recordClaudeAgentSdkReplayTranscript({
          scenario: fixture.name,
          prompts: [SIMPLE_PROMPT],
          modelSelection: provider.modelSelection,
          cwd: checkpointWorkspace,
        });

        assert.equal(transcript.provider, "claudeAgent");
        assert.equal(transcript.protocol, "claude-agent-sdk.query");
        assert.isAtLeast(transcript.entries.length, 3);
      } finally {
        await removeDirectory(checkpointWorkspace);
      }
    },
  );

  it("replays simple as typed Claude Agent SDK query messages", async () => {
    const { provider } = claudeFixture("simple");

    const rawTranscript = await readTranscript(provider.transcriptFile);
    const transcript = await Effect.runPromise(
      ClaudeOrchestratorReplayHarness.decodeTranscript(rawTranscript),
    );

    const messages = await replayClaudeAgentSdkTranscript({
      transcript,
      prompts: [SIMPLE_PROMPT],
      modelSelection: provider.modelSelection,
    });

    assert.include(
      messages
        .filter((message) => message.type === "assistant")
        .flatMap((message) =>
          message.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
        )
        .join(""),
      "fixture simple ok",
    );
  });

  it("replays multi_turn as typed Claude Agent SDK query messages", async () => {
    const { provider } = claudeFixture("multi_turn");

    const rawTranscript = await readTranscript(provider.transcriptFile);
    const transcript = await Effect.runPromise(
      ClaudeOrchestratorReplayHarness.decodeTranscript(rawTranscript),
    );

    const messages = await replayClaudeAgentSdkTranscript({
      transcript,
      prompts: [MULTI_TURN_FIRST_PROMPT, MULTI_TURN_SECOND_PROMPT],
      modelSelection: provider.modelSelection,
    });

    const assistantText = messages
      .filter((message) => message.type === "assistant")
      .flatMap((message) =>
        message.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
      )
      .join("\n");
    assert.include(assistantText, "first fixture turn complete");
    assert.include(assistantText, "second fixture turn complete");
  });
});
