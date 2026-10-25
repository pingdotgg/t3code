import { projectionFor } from "./fixtures/shared.ts";
import type { ProviderReplayEntry } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { PiOrchestratorReplayHarness } from "../Adapters/PiAdapterV2.testkit.ts";
import {
  findReplayFixture,
  itRunsReplayFixtures,
  runReplayFixture,
} from "./ProviderReplayFixtures.ts";

describe("Pi replay fixtures", () => {
  itRunsReplayFixtures("pi", (input) =>
    runReplayFixture({ ...input, harness: PiOrchestratorReplayHarness }),
  );
  it.effect("keeps Pi decisions and text answers after the provider turn ends", () => {
    const fixture = findReplayFixture("simple");
    const provider = fixture?.providers.find((candidate) => candidate.driver === "pi");
    assert.isDefined(fixture);
    assert.isDefined(provider);
    const answers = { "ui-input": "Keep the existing tests" };
    return runReplayFixture({
      harness: PiOrchestratorReplayHarness,
      fixtureName: fixture.name,
      buildInput: () => ({
        ...fixture.buildInput(),
        steps: [
          ...fixture.buildInput().steps,
          { type: "approve_next_runtime_request", decision: "accept" },
          { type: "approve_next_runtime_request", decision: "decline" },
          { type: "answer_next_user_input_request", answers },
        ],
      }),
      driver: {
        ...provider,
        assertOutput: (result) => {
          const projection = projectionFor(result, fixture.name);
          assert.lengthOf(projection.runtimeRequests, 3);
          for (const [nativeId, response, status] of [
            ["ui-accept", { decision: "accept" }, "completed"],
            ["ui-decline", { decision: "decline" }, "cancelled"],
            ["ui-input", { answers }, "completed"],
          ] as const) {
            const request = projection.runtimeRequests.find(
              (candidate) => candidate.nativeRequestRef?.nativeId === nativeId,
            );
            assert.isDefined(request);
            assert.deepInclude(request, { status: "resolved", ...response });
            assert.equal(
              projection.nodes.find((node) => node.id === request.nodeId)?.status,
              status,
            );
            assert.equal(
              projection.turnItems.find((item) => item.nodeId === request.nodeId)?.status,
              status,
            );
          }
          assert.equal(projection.runs.at(-1)?.status, "completed");
        },
      },
      transformTranscript: (transcript) => {
        const at = transcript.entries.findIndex(
          (entry) => entry.type === "emit_inbound" && entry.label === "turn_start",
        );
        assert.isAtLeast(at, 0, "Pi fixture must contain turn_start");
        return {
          ...transcript,
          entries: [
            ...transcript.entries.slice(0, at + 1),
            ...(["accept", "decline"] as const).flatMap((decision): ProviderReplayEntry[] => [
              {
                type: "emit_inbound",
                frame: {
                  type: "extension_ui_request",
                  id: `ui-${decision}`,
                  method: "confirm",
                  title: "Allow bash?",
                },
              },
              {
                type: "expect_outbound",
                frame: {
                  type: "extension_ui_response",
                  id: `ui-${decision}`,
                  confirmed: decision === "accept",
                },
              },
            ]),
            {
              type: "emit_inbound",
              frame: {
                type: "extension_ui_request",
                id: "ui-input",
                method: "input",
                title: "How?",
              },
            },
            {
              type: "expect_outbound",
              frame: { type: "extension_ui_response", id: "ui-input", value: answers["ui-input"] },
            },
            ...transcript.entries.slice(at + 1),
          ],
        };
      },
    });
  });
});
