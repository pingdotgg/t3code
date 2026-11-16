import { describe, expect, it } from "vite-plus/test";

import {
  buildConversationSummaryPrompt,
  buildKnowledgeCandidatesPrompt,
  buildThreadTitlePrompt,
} from "./textGenerationPrompts.ts";
import { normalizeCliError } from "./textGenerationUtils.ts";

describe("normalizeCliError", () => {
  it("does not expose CLI failure details in the public error message", () => {
    const result = normalizeCliError(
      "codex",
      "generateCommitMessage",
      new Error("request failed with access_token=secret-token"),
      "Failed to generate a commit message",
    );

    expect(result.detail).toBe("Failed to generate a commit message");
    expect(result.message).not.toContain("secret-token");
  });
});

it("preserves each run boundary and terminal outcome in family review prompts", () => {
  const { prompt } = buildKnowledgeCandidatesPrompt({
    runOutcome: "completed",
    messages: [
      {
        ref: "M1",
        role: "user",
        text: "Keep the API stable.",
        threadId: "root",
        runId: "run-a",
        runOutcome: "interrupted",
      },
      {
        ref: "M2",
        role: "assistant",
        text: "Checked compatibility.",
        threadId: "child",
        runId: "run-b",
        runOutcome: "completed",
      },
    ],
  });
  expect(prompt).toContain("[M1] user (T1/R1, interrupted):\nKeep the API stable.");
  expect(prompt).toContain("[M2] assistant (T2/R2, completed):\nChecked compatibility.");
});

const noPeer = [
  { ref: "M1", role: "user", text: "Where should sessions live?" },
  { ref: "M2", role: "assistant", text: "Keep Redis." },
] as const;
const withPeer = [
  ...noPeer,
  {
    ref: "M3",
    role: "peer",
    speaker: { label: "Astra", model: "gpt-6-astra" },
    text: "Use Postgres.",
  },
] as const;

it.each([
  [
    "summary",
    (messages: typeof withPeer | typeof noPeer) =>
      buildConversationSummaryPrompt({ messages }).prompt,
  ],
  [
    "knowledge",
    (messages: typeof withPeer | typeof noPeer) =>
      buildKnowledgeCandidatesPrompt({ runOutcome: "completed", messages }).prompt,
  ],
])("adds the %s peer rule only when a peer spoke", (_, build) => {
  const rules = (prompt: string) =>
    prompt.slice(0, prompt.search(/\n(?:Sources|Messages):/)).split("\n");
  const withoutPeer = rules(build(noPeer));
  const peerOnly = rules(build(withPeer)).filter((line) => !withoutPeer.includes(line));
  expect(peerOnly).toHaveLength(1);
  expect(rules(build(withPeer)).filter((line) => line !== peerOnly[0])).toEqual(withoutPeer);
});

describe("buildThreadTitlePrompt", () => {
  it("names the project to leave out of initial and regenerated titles", () => {
    for (const previousTitle of [undefined, "Hyperdrive Config Crash"]) {
      const { prompt } = buildThreadTitlePrompt({
        message: "hyperdrive init crashes without a config",
        previousTitle,
        projectTitle: "Hyperdrive",
      });
      expect(prompt).toContain('Never include the project name ("Hyperdrive")');
    }
  });
});
