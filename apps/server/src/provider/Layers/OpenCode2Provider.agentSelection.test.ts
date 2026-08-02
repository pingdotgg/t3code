import type { AgentInfoV2, ModelInfo } from "@opencode-ai/sdk-next/v2";
import { describe, expect, it } from "vite-plus/test";

import { flattenOpenCode2Models } from "./OpenCode2Provider.ts";

const MODEL = {
  id: "glm-5.2",
  modelID: "glm-5.2",
  providerID: "opencode",
  name: "GLM-5.2",
  capabilities: {
    tools: true,
    input: ["text"],
    output: ["text"],
  },
  variants: [],
  time: { released: 0 },
  cost: [],
  status: "active",
  enabled: true,
  limit: {
    context: 128_000,
    output: 16_384,
  },
} satisfies ModelInfo;

const BUILD_AGENT = {
  id: "build",
  name: "Build",
  request: { settings: {}, headers: {}, body: {} },
  mode: "primary",
  hidden: false,
  permissions: [],
} satisfies AgentInfoV2;

const PLAN_AGENT = { ...BUILD_AGENT, id: "plan", name: "Plan" } satisfies AgentInfoV2;

describe("OpenCode 2 agent inventory", () => {
  // The Build/Plan interaction-mode toggle owns the native pair, so no Agent
  // descriptor appears unless custom primary agents exist.
  it("suppresses the agent descriptor when only build and plan exist", () => {
    const [model] = flattenOpenCode2Models({
      models: [MODEL],
      agents: [BUILD_AGENT, PLAN_AGENT],
    });

    expect(
      model?.capabilities?.optionDescriptors?.some((candidate) => candidate.id === "agent"),
    ).toBe(false);
  });

  it("suppresses the agent descriptor when the native pair is incomplete", () => {
    const customAgent = {
      ...BUILD_AGENT,
      id: "release-captain",
      name: "Release Captain",
    } satisfies AgentInfoV2;
    const [model] = flattenOpenCode2Models({
      models: [MODEL],
      agents: [BUILD_AGENT, customAgent],
    });
    expect(
      model?.capabilities?.optionDescriptors?.some((candidate) => candidate.id === "agent"),
    ).toBe(false);
  });

  it("suppresses the agent descriptor when only plan and a custom agent exist", () => {
    const customAgent = {
      ...BUILD_AGENT,
      id: "release-captain",
      name: "Release Captain",
    } satisfies AgentInfoV2;
    const [model] = flattenOpenCode2Models({
      models: [MODEL],
      agents: [PLAN_AGENT, customAgent],
    });
    expect(
      model?.capabilities?.optionDescriptors?.some((candidate) => candidate.id === "agent"),
    ).toBe(false);
  });

  it("keeps executable agent ids separate from title-cased labels", () => {
    const customAgent = {
      ...BUILD_AGENT,
      id: "Release-Captain",
      name: "Release Captain",
    } satisfies AgentInfoV2;
    const [model] = flattenOpenCode2Models({
      models: [MODEL],
      agents: [customAgent, BUILD_AGENT, PLAN_AGENT],
    });
    const descriptor = model?.capabilities?.optionDescriptors?.find(
      (candidate) => candidate.id === "agent",
    );

    // Custom agents ride behind the Auto sentinel; build/plan belong to the
    // Build/Plan toggle and leave the submenu entirely.
    expect(descriptor).toEqual({
      id: "agent",
      label: "Agent",
      type: "select",
      currentValue: "auto",
      options: [
        { id: "auto", label: "Auto (Build/Plan)" },
        { id: "Release-Captain", label: "Release Captain" },
      ],
    });
  });
});
