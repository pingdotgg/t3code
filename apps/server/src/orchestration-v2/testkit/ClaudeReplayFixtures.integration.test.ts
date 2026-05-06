import { assert, describe, it } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";
import { Effect } from "effect";
import { readFile, rm } from "node:fs/promises";

import {
  ClaudeOrchestratorReplayHarness,
  recordClaudeAgentSdkReplayTranscript,
  replayClaudeAgentSdkTranscript,
} from "../Adapters/ClaudeAdapterV2.testkit.ts";
import { layer as idAllocatorLayer } from "../IdAllocator.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { CLAUDE_REPLAY_FIXTURES } from "./fixtures/claude.ts";
import { materializeFixtureInput, SIMPLE_PROMPT } from "./fixtures/shared.ts";
import {
  runOrchestratorV2ProviderReplayScenario,
  type OrchestratorV2ProviderReplayScenario,
} from "./ProviderReplayHarness.ts";
import { makeCheckpointWorkspace } from "./ReplayFixtureWorkspace.ts";
import { decodeProviderReplayNdjson } from "./ReplayTranscriptNdjson.ts";

async function readTranscript(file: URL): Promise<ProviderReplayTranscript> {
  const text = await readFile(file, "utf8");
  return await Effect.runPromise(decodeProviderReplayNdjson(text));
}

function simpleClaudeFixture() {
  const fixture = CLAUDE_REPLAY_FIXTURES.find((entry) => entry.name === "simple");
  const provider = fixture?.providers[0];
  if (fixture === undefined || provider === undefined) {
    throw new Error("Missing simple/claudeAgent replay fixture.");
  }
  return { fixture, provider };
}

describe("Claude Agent SDK replay fixtures", () => {
  it.skipIf(process.env.T3_RECORD_CLAUDE_AGENT_SDK_FIXTURE !== "1")(
    "records simple from real Claude Code query() output",
    async () => {
      const { fixture, provider } = simpleClaudeFixture();

      const checkpointWorkspace = await makeCheckpointWorkspace("claude-simple-record");
      try {
        const transcript = await recordClaudeAgentSdkReplayTranscript({
          scenario: fixture.name,
          prompt: SIMPLE_PROMPT,
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
    const { provider } = simpleClaudeFixture();

    const rawTranscript = await readTranscript(provider.transcriptFile);
    const transcript = await Effect.runPromise(
      ClaudeOrchestratorReplayHarness.decodeTranscript(rawTranscript),
    );

    const messages = await replayClaudeAgentSdkTranscript({
      transcript,
      prompt: SIMPLE_PROMPT,
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

  for (const fixture of CLAUDE_REPLAY_FIXTURES) {
    for (const provider of fixture.providers) {
      it(`runs ${fixture.name}/${provider.provider} through OrchestratorV2 using deterministic replay`, async () => {
        const rawTranscript = await readTranscript(provider.transcriptFile);
        const transcript = await Effect.runPromise(
          ClaudeOrchestratorReplayHarness.decodeTranscript(rawTranscript),
        );
        const checkpointWorkspace = await makeCheckpointWorkspace(`${fixture.name}-claude`);
        const materialized = await Effect.runPromise(
          materializeFixtureInput({
            scenario: fixture.name,
            fixtureInput: fixture.buildInput(),
            modelSelection: provider.modelSelection,
          }).pipe(Effect.provide(idAllocatorLayer), provideDeterministicTestRuntime),
        );

        try {
          const scenario = {
            name: `${fixture.name}/${provider.provider}`,
            transcript,
            commands: materialized.commands,
            steps: materialized.steps,
            projectionThreadIds: materialized.projectionThreadIds,
            runtimePolicyOverride: {
              ...provider.runtimePolicyOverride,
              cwd: checkpointWorkspace,
            },
          } satisfies OrchestratorV2ProviderReplayScenario<typeof transcript>;

          const result = await Effect.runPromise(
            runOrchestratorV2ProviderReplayScenario(scenario, ClaudeOrchestratorReplayHarness).pipe(
              provideDeterministicTestRuntime,
            ),
          );

          provider.assertOutput(result, transcript);
        } finally {
          await rm(checkpointWorkspace, { recursive: true, force: true });
        }
      });
    }
  }
});
