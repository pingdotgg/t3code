import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, type ProviderReplayTranscript } from "@t3tools/contracts";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

import { materializeReplayTranscriptRuntimeInstructions } from "./ReplayRuntimeInstructions.ts";

const runtime = { driver: ProviderDriverKind.make("muse"), model: "fixture-default-model" };
const legacyGuidance =
  "<pull_request_linking>Watch the PR until monitoring is done.</pull_request_linking>";
const currentGuidancePattern = /<pull_request_linking>[\s\S]*?<\/pull_request_linking>/u;

function transcript(entries: ProviderReplayTranscript["entries"]): ProviderReplayTranscript {
  return {
    provider: "muse",
    protocol: "muse.msp-jsonl",
    version: "1",
    scenario: "runtime-instructions",
    entries,
  };
}

function turnStart(id: number, instructions: string, prompt: string, reasoningEffort: string) {
  return {
    type: "expect_outbound" as const,
    label: "turn/start",
    frame: {
      jsonrpc: "2.0",
      id,
      method: "turn/start",
      params: {
        sessionId: "muse-session",
        input: [
          { type: "text", text: instructions },
          { type: "text", text: prompt },
        ],
        displayText: prompt,
        reasoningEffort,
        commandId: `muse-command-${id}`,
      },
    },
  };
}

describe("materializeReplayTranscriptRuntimeInstructions", () => {
  it("refreshes Muse runtime guidance while preserving each turn's model and runtime options", () => {
    const expectedTurns = [
      { model: "muse-first-model", reasoningEffort: "low", prompt: "First request" },
      { model: "muse-second-model", reasoningEffort: "high", prompt: "Second request" },
    ].map((options, index) =>
      turnStart(
        index + 1,
        buildRuntimeInstructions({ harness: "Muse Code", ...options }),
        options.prompt,
        options.reasoningEffort,
      ),
    );
    const recorded = transcript(
      expectedTurns.map((entry, turnIndex) => {
        const frame = entry.frame;
        return {
          ...entry,
          frame: {
            ...frame,
            params: {
              ...frame.params,
              input: frame.params.input.map((part, index) =>
                index === 0
                  ? {
                      ...part,
                      text: part.text
                        .replace(
                          /<runtime_info>If asked: you're running (.+?)\. Embed media[^<]+<\/runtime_info>/u,
                          "<runtime_info>In case you're asked: you are running $1. No need to mention this otherwise. Legacy file guidance.</runtime_info>",
                        )
                        .replace(currentGuidancePattern, legacyGuidance)
                        .replace(
                          /\n\n<github_reads>[\s\S]*?<\/github_reads>/u,
                          turnIndex === 0
                            ? ""
                            : "\n\n<github_reads>Old GitHub guidance.</github_reads>",
                        ),
                    }
                  : part,
              ),
            },
          },
        };
      }),
    );

    assert.deepEqual(
      materializeReplayTranscriptRuntimeInstructions(recorded, runtime),
      transcript(expectedTurns),
    );
    assert.deepEqual(
      materializeReplayTranscriptRuntimeInstructions(transcript(expectedTurns), runtime),
      transcript(expectedTurns),
    );
  });

  it("materializes new GitHub read guidance for legacy Muse transcripts", () => {
    const currentInstructions = buildRuntimeInstructions({ harness: "Muse Code", model: "muse" });
    const oldReadGuidance = /\n\n<github_reads>[\s\S]*?<\/github_reads>/u;
    const legacyInstructions = currentInstructions
      .replace(currentGuidancePattern, legacyGuidance)
      .replace(oldReadGuidance, "");
    const staleInstructions = currentInstructions
      .replace(currentGuidancePattern, legacyGuidance)
      .replace(oldReadGuidance, "\n\n<github_reads>Use direct gh reads.</github_reads>");

    for (const recordedInstructions of [legacyInstructions, staleInstructions]) {
      const recorded = transcript([turnStart(1, recordedInstructions, "Original prompt", "low")]);
      const expected = transcript([turnStart(1, currentInstructions, "Original prompt", "low")]);
      assert.deepEqual(materializeReplayTranscriptRuntimeInstructions(recorded, runtime), expected);
    }
  });

  it("preserves user text, other instructions, inbound frames, and non-turn requests", () => {
    const currentInstructions = buildRuntimeInstructions({ harness: "Muse Code", model: "muse" });
    const suffix = "\n\n<task_instructions>Keep this instruction exact.</task_instructions>";
    const recordedInstructions = currentInstructions.replace(
      currentGuidancePattern,
      legacyGuidance,
    );
    const prompt = `${recordedInstructions}\nThis is literal user text, including the old guidance.`;
    const start = turnStart(1, recordedInstructions + suffix, prompt, "low");
    const inbound = { ...start, type: "emit_inbound" as const };
    const otherRequest = {
      ...start,
      frame: {
        ...start.frame,
        method: "session/prompt",
        params: { prompt: [{ type: "text", text: recordedInstructions }] },
      },
    };
    const missingRuntimeHeader = turnStart(2, legacyGuidance, prompt, "high");
    const recorded = transcript([start, inbound, otherRequest, missingRuntimeHeader]);

    assert.deepEqual(
      materializeReplayTranscriptRuntimeInstructions(recorded, runtime),
      transcript([
        turnStart(1, currentInstructions + suffix, prompt, "low"),
        inbound,
        otherRequest,
        missingRuntimeHeader,
      ]),
    );
    assert.deepEqual(
      materializeReplayTranscriptRuntimeInstructions(recorded, {
        ...runtime,
        driver: ProviderDriverKind.make("codex"),
      }),
      recorded,
    );
  });
});
