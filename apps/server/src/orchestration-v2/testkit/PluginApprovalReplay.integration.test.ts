import { assert, describe, it } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";
import { PiOrchestratorReplayHarness } from "../Adapters/PiAdapterV2.testkit.ts";
import { OpenCodeOrchestratorReplayHarness } from "../Adapters/OpenCodeAdapterV2.testkit.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "./fixtures/index.ts";
import { runReplayFixture, type ReplayFixtureCase } from "./ProviderReplayFixtures.ts";
function runPluginApprovalFixture(input: ReplayFixtureCase) {
  return input.driver.driver === "pi"
    ? runReplayFixture({ ...input, harness: PiOrchestratorReplayHarness })
    : runReplayFixture({ ...input, harness: OpenCodeOrchestratorReplayHarness });
}
describe("plugin approval replay acknowledgement", () => {
  // Pi and OpenCode report a request answered after T3 sends its answer. The
  // orchestrator's record (decision, decline status, the plugin that answered)
  // must survive the response worker and that acknowledgement.
  it.effect.each(
    (
      [
        ["opencode", "opencode_child_approval", "accept"],
        ["opencode", "opencode_child_approval", "decline"],
        ["pi", "simple", "accept"],
        ["pi", "simple", "decline"],
      ] as const
    ).flatMap(([driver, fixtureName, decision]) => {
      const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find(
        (candidate) => candidate.name === fixtureName,
      );
      const provider = fixture?.providers.find((candidate) => candidate.driver === driver);
      return fixture === undefined || provider === undefined
        ? []
        : [[driver, decision, fixture, provider] as const];
    }),
  )(
    "keeps a plugin's answer through %s's acknowledgement (%s)",
    ([driver, decision, fixture, provider]) => {
      const resolvedBy = {
        _tag: "plugin",
        pluginId: "test.policy",
        pluginName: "Test policy",
        decision,
        reason: "Fixture policy.",
      } as const;
      const prompt = fixture.buildInput().steps[0];
      return runPluginApprovalFixture({
        fixtureName: fixture.name,
        buildInput: () => ({
          steps: [
            ...(prompt === undefined ? [] : [prompt]),
            { type: "approve_next_runtime_request", decision, resolvedBy },
          ],
        }),
        driver: {
          ...provider,
          assertOutput: (result) => {
            const status = decision === "accept" ? "completed" : "cancelled";
            const projection = [...result.projections.values()].find(
              (candidate) => candidate.thread.lineage.parentThreadId === null,
            );
            const item = projection?.turnItems.find(
              (candidate) => candidate.type === "approval_request",
            );
            assert.deepInclude(item, { status, resolvedBy });
            assert.deepInclude(projection?.runtimeRequests[0], { status: "resolved", decision });
            // The last word on the card and the request, as every client and a replay read them.
            const card = result.domainEvents.findLast(
              (event) => event.type === "turn-item.updated" && event.payload.id === item?.id,
            );
            assert.deepInclude(card?.payload, { status, resolvedBy });
            const request = result.domainEvents.findLast(
              (event) => event.type === "runtime-request.updated",
            );
            assert.deepInclude(request?.payload, { status: "resolved", decision });
          },
        },
        transformTranscript: (transcript) =>
          driver === "pi"
            ? withPiConfirm(transcript, decision)
            : withOpenCodeReply(transcript, decision),
      });
    },
  );
});

/** Adds an extension confirm dialog to the turn and the answer T3 sends for it. */
function withPiConfirm(
  transcript: ProviderReplayTranscript,
  decision: "accept" | "decline",
): ProviderReplayTranscript {
  const at = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "turn_start",
  );
  const id = "ui-plugin-approval";
  return {
    ...transcript,
    entries: [
      ...transcript.entries.slice(0, at + 1),
      {
        type: "emit_inbound",
        label: "extension_ui_request.confirm",
        frame: { type: "extension_ui_request", id, method: "confirm", title: "Allow bash?" },
      },
      {
        type: "expect_outbound",
        label: "extension_ui_response",
        frame: { type: "extension_ui_response", id, confirmed: decision === "accept" },
      },
      ...transcript.entries.slice(at + 1),
    ],
  };
}

/** The recorded permission reply and its echo, rejected instead when declining. */
function withOpenCodeReply(
  transcript: ProviderReplayTranscript,
  decision: "accept" | "decline",
): ProviderReplayTranscript {
  if (decision === "accept") return transcript;
  return {
    ...transcript,
    entries: transcript.entries.map((entry) => {
      if (entry.type === "expect_outbound" && entry.label === "permission.reply") {
        const frame = entry.frame as { readonly input: object };
        return { ...entry, frame: { ...frame, input: { ...frame.input, reply: "reject" } } };
      }
      if (entry.type === "emit_inbound" && entry.label === "child.permission.replied") {
        const frame = entry.frame as { readonly event: { readonly properties: object } };
        const event = {
          ...frame.event,
          properties: { ...frame.event.properties, reply: "reject" },
        };
        return { ...entry, frame: { ...frame, event } };
      }
      return entry;
    }),
  };
}
