import { assert, describe, it } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";
import { Effect } from "effect";
import { readFile, rm } from "node:fs/promises";

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
  const text = await readFile(file, "utf8");
  return await Effect.runPromise(decodeProviderReplayNdjson(text));
}

function claudeFixture(name: string) {
  const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find((entry) => entry.name === name);
  const provider = fixture?.providers.find((entry) => entry.provider === "claudeAgent");
  if (fixture === undefined || provider === undefined) {
    throw new Error(`Missing ${name}/claudeAgent replay fixture.`);
  }
  return { fixture, provider };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
        await rm(checkpointWorkspace, { recursive: true, force: true });
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
