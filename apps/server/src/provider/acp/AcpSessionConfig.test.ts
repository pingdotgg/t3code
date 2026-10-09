import { describe, expect, it } from "@effect/vitest";
import { ModelCapabilities } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { ACP_SESSION_MODE_OPTION_ID, acpProviderOptionDescriptors } from "./AcpSessionConfig.ts";

const decodeCapabilities = Schema.decodeUnknownSync(ModelCapabilities);
const emptyValue = "__acp_default__".padEnd(257, "_");

describe("acpProviderOptionDescriptors", () => {
  it("represents empty agent choices with a nonempty sentinel through the contract", () => {
    const descriptors = acpProviderOptionDescriptors({
      configOptions: [
        {
          id: "agent",
          name: "Selection",
          type: "select",
          currentValue: "",
          options: [
            { value: "", name: "Provider default" },
            { value: "custom", name: "Custom" },
          ],
        },
      ],
      modeState: undefined,
    });
    expect(
      decodeCapabilities({
        optionDescriptors: descriptors,
      }),
    ).toEqual({
      optionDescriptors: [
        {
          id: "agent",
          label: "Selection",
          type: "select",
          currentValue: emptyValue,
          options: [
            { id: emptyValue, label: "Provider default" },
            { id: "custom", label: "Custom" },
          ],
        },
      ],
    });
  });

  it("maps non-model select options and excludes model and collaboration categories", () => {
    const descriptors = acpProviderOptionDescriptors({
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "gpt-5.6-sol",
          options: [{ value: "gpt-5.6-sol", name: "GPT-5.6-Sol" }],
        },
        {
          id: "collaboration_mode",
          name: "Collaboration mode",
          category: "collaboration_mode",
          type: "select",
          currentValue: "default",
          options: [
            { value: "default", name: "Default" },
            { value: "plan", name: "Plan" },
          ],
        },
        {
          id: "reasoning_effort",
          name: "Reasoning effort",
          category: "thought_level",
          type: "select",
          currentValue: "medium",
          options: [
            { value: "low", name: "Low" },
            { value: "medium", name: "Medium", description: "Balanced" },
          ],
        },
      ],
      modeState: undefined,
    });

    expect(descriptors).toEqual([
      {
        id: "reasoning_effort",
        label: "Reasoning effort",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium", description: "Balanced" },
        ],
        currentValue: "medium",
      },
    ]);
  });

  it("maps boolean session options", () => {
    const descriptors = acpProviderOptionDescriptors({
      configOptions: [
        {
          id: "fast_mode",
          name: "Fast mode",
          description: "Use lower-latency inference.",
          type: "boolean",
          currentValue: true,
        },
      ],
      modeState: undefined,
    });

    expect(descriptors).toEqual([
      {
        id: "fast_mode",
        label: "Fast mode",
        description: "Use lower-latency inference.",
        type: "boolean",
        currentValue: true,
      },
    ]);
  });

  it("flattens grouped select choices and drops duplicate and blank values", () => {
    const descriptors = acpProviderOptionDescriptors({
      configOptions: [
        {
          id: "sandbox",
          name: "Sandbox",
          type: "select",
          currentValue: "workspace",
          options: [
            {
              groupId: "standard",
              name: "Standard",
              options: [
                { value: "workspace", name: "Workspace" },
                { value: " ", name: "Blank" },
              ],
            },
            {
              groupId: "extra",
              name: "Extra",
              options: [
                { value: "workspace", name: "Duplicate" },
                { value: "full", name: "Full" },
              ],
            },
          ],
        },
      ],
      modeState: undefined,
    });

    expect(descriptors).toEqual([
      {
        id: "sandbox",
        label: "Sandbox",
        type: "select",
        options: [
          { id: "workspace", label: "Workspace" },
          { id: "full", label: "Full" },
        ],
        currentValue: "workspace",
      },
    ]);
  });

  it("synthesizes a mode descriptor for agents without a mode config option", () => {
    const descriptors = acpProviderOptionDescriptors({
      configOptions: [],
      modeState: {
        currentModeId: "safe",
        availableModes: [
          { id: "safe", name: "Safe" },
          { id: "yolo", name: "YOLO", description: "No approvals" },
        ],
      },
    });

    expect(descriptors).toEqual([
      {
        id: ACP_SESSION_MODE_OPTION_ID,
        label: "Mode",
        description: "Session mode advertised by the ACP agent.",
        type: "select",
        options: [
          { id: "safe", label: "Safe" },
          { id: "yolo", label: "YOLO", description: "No approvals" },
        ],
        currentValue: "safe",
      },
    ]);
  });

  it.each([
    { currentModeId: "", currentValue: emptyValue },
    { currentModeId: "__acp_default__", currentValue: "__acp_default__" },
    {
      currentModeId: "__acp_default__".padEnd(256, "_"),
      currentValue: "__acp_default__".padEnd(256, "_"),
    },
  ])("keeps empty and legacy session modes distinct for $currentModeId", (selection) => {
    const descriptors = acpProviderOptionDescriptors({
      configOptions: [],
      modeState: {
        currentModeId: selection.currentModeId,
        availableModes: [
          { id: "", name: "Provider default" },
          { id: "__acp_default__", name: "Literal value" },
          { id: "__acp_default__".padEnd(256, "_"), name: "Longest legacy value" },
          { id: emptyValue, name: "Too long" },
        ],
      },
    });

    expect(decodeCapabilities({ optionDescriptors: descriptors }).optionDescriptors).toEqual([
      {
        id: ACP_SESSION_MODE_OPTION_ID,
        label: "Mode",
        description: "Session mode advertised by the ACP agent.",
        type: "select",
        currentValue: selection.currentValue,
        options: [
          { id: emptyValue, label: "Provider default" },
          { id: "__acp_default__", label: "Literal value" },
          { id: "__acp_default__".padEnd(256, "_"), label: "Longest legacy value" },
        ],
      },
    ]);
  });

  it("suppresses the synthetic mode descriptor when modes duplicate a config option", () => {
    const descriptors = acpProviderOptionDescriptors({
      configOptions: [
        {
          id: "thinking",
          name: "Thinking",
          category: "thought_level",
          type: "select",
          currentValue: "medium",
          options: [
            { value: "off", name: "Thinking: off" },
            { value: "medium", name: "Thinking: medium" },
          ],
        },
      ],
      modeState: {
        currentModeId: "medium",
        availableModes: [
          { id: "off", name: "Thinking: off" },
          { id: "medium", name: "Thinking: medium" },
        ],
      },
    });

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual(["thinking"]);
  });

  it("does not let an unrelated select option hide the session modes API", () => {
    const descriptors = acpProviderOptionDescriptors({
      configOptions: [
        {
          id: "unrelated",
          name: "Unrelated",
          type: "select",
          currentValue: "safe",
          options: [
            { value: "safe", name: "Safe" },
            { value: "yolo", name: "YOLO" },
          ],
        },
      ],
      modeState: {
        currentModeId: "safe",
        availableModes: [
          { id: "safe", name: "Safe" },
          { id: "yolo", name: "YOLO" },
        ],
      },
    });

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual([
      "unrelated",
      ACP_SESSION_MODE_OPTION_ID,
    ]);
  });

  it("preserves legacy sentinel-like values and rejects invalid choices", () => {
    const exactValue = "__acp_default__";
    const longestLegacyValue = exactValue.padEnd(256, "_");
    const descriptors = acpProviderOptionDescriptors({
      configOptions: [
        {
          id: "opaque",
          name: "Opaque",
          type: "select",
          currentValue: exactValue,
          options: [
            { value: exactValue, name: "Exact" },
            { value: `${exactValue}${exactValue}`, name: "Repeated prefix" },
            { value: longestLegacyValue, name: "Longest legacy value" },
            { value: " value with spaces ", name: "Padded" },
            { value: "", name: " " },
            { value: emptyValue, name: "Too long" },
          ],
        },
      ],
      modeState: undefined,
    });

    expect(descriptors[0]).toMatchObject({
      id: "opaque",
      currentValue: exactValue,
      options: [
        { id: exactValue, label: "Exact" },
        { id: `${exactValue}${exactValue}`, label: "Repeated prefix" },
        { id: longestLegacyValue, label: "Longest legacy value" },
        { id: emptyValue, label: "Default" },
      ],
    });
  });

  it("suppresses the synthetic mode descriptor when a mode-category option exists", () => {
    const descriptors = acpProviderOptionDescriptors({
      configOptions: [
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "agent",
          options: [
            { value: "read-only", name: "Read-only" },
            { value: "agent", name: "Agent" },
          ],
        },
      ],
      modeState: {
        currentModeId: "agent",
        availableModes: [
          { id: "read-only", name: "Read-only" },
          { id: "agent", name: "Agent" },
          { id: "agent-full-access", name: "Agent (full access)" },
        ],
      },
    });

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual(["mode"]);
  });
});
