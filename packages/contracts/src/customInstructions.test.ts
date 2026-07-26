import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  CustomInstructionsConfig,
  DEFAULT_CUSTOM_INSTRUCTIONS_CONFIG,
} from "./customInstructions.ts";

const decodeCustomInstructions = Schema.decodeUnknownSync(CustomInstructionsConfig);
const encodeCustomInstructions = Schema.encodeSync(CustomInstructionsConfig);

describe("CustomInstructionsConfig", () => {
  it("decodes an empty config to the complete default shape", () => {
    expect(decodeCustomInstructions({})).toEqual(DEFAULT_CUSTOM_INSTRUCTIONS_CONFIG);
    expect(DEFAULT_CUSTOM_INSTRUCTIONS_CONFIG).toEqual({
      global: { instructions: [], agents: [], presets: [] },
      projects: {},
    });
  });

  it("decodes legacy-empty nested bundles and ignores unknown fields", () => {
    expect(
      decodeCustomInstructions({
        legacyInstructions: [],
        global: { legacyAgents: [], legacyPresets: [] },
        projects: {
          "project-legacy": {},
        },
      }),
    ).toEqual({
      global: { instructions: [], agents: [], presets: [] },
      projects: {
        "project-legacy": { instructions: [], agents: [], presets: [] },
      },
    });
  });

  it("defaults instruction entries to enabled", () => {
    const decoded = decodeCustomInstructions({
      global: {
        instructions: [
          {
            id: "default-enabled",
            scope: { kind: "global" },
            text: "  Keep changes focused.  ",
          },
        ],
      },
    });

    expect(decoded.global.instructions).toEqual([
      {
        id: "default-enabled",
        scope: { kind: "global" },
        text: "Keep changes focused.",
        enabled: true,
      },
    ]);
  });

  it("round-trips all scopes, targets, model options, and presets", () => {
    const decoded = decodeCustomInstructions({
      global: {
        instructions: [
          {
            id: "global-note",
            scope: { kind: "global" },
            text: "  Apply the repository conventions.  ",
          },
          {
            id: "provider-note",
            scope: { kind: "provider", driver: "codex" },
            text: "Use the Codex workflow.",
            enabled: true,
          },
          {
            id: "model-note",
            scope: {
              kind: "model",
              instanceId: "codex_work",
              model: " gpt-5.6-luna ",
            },
            text: "Prefer small, reviewable patches.",
          },
          {
            id: "task-note",
            scope: { kind: "taskType", taskType: "review" },
            text: "Call out missing test coverage.",
            enabled: false,
          },
        ],
        agents: [
          {
            id: "reviewer",
            name: "  review\nagent  ",
            description: "Checks a change before merge.",
            taskType: "review",
            target: { kind: "instance", instanceId: "codex_work" },
            model: " gpt-5.6-luna ",
            modelOptions: [
              { id: "reasoningEffort", value: " max " },
              { id: "serviceTier", value: "priority" },
            ],
            prompt: "  Review the requested change and report actionable findings.  ",
          },
          {
            id: "investigator",
            name: "investigator",
            target: { kind: "driver", driver: "claudeAgent" },
            prompt: "Investigate the issue and summarize the evidence.",
          },
        ],
        presets: [
          {
            id: "review-preset",
            name: "  Careful review  ",
            taskType: "review",
            modelSelection: {
              instanceId: "codex_work",
              model: "gpt-5.6-luna",
              options: [{ id: "reasoningEffort", value: "high" }],
            },
            instructionRefs: ["global-note", "task-note"],
            extraInstructions: "  Include file and line references.  ",
          },
        ],
      },
      projects: {
        "project-1": {
          instructions: [
            {
              id: "project-note",
              scope: { kind: "global" },
              text: "Use the project's local conventions.",
            },
          ],
        },
      },
    });

    const roundTripped = decodeCustomInstructions(encodeCustomInstructions(decoded));

    expect(roundTripped).toEqual(decoded);
    expect(roundTripped.global.instructions.map((entry) => entry.scope.kind)).toEqual([
      "global",
      "provider",
      "model",
      "taskType",
    ]);
    expect(roundTripped.global.agents[0]?.modelOptions).toEqual([
      { id: "reasoningEffort", value: "max" },
      { id: "serviceTier", value: "priority" },
    ]);
  });
});
