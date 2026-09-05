import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createMcpGatewayProfile,
  McpEnvironmentGrantMatrix,
  McpGatewayProfileEditor,
  selectAllMcpGatewayGrants,
  setMcpGatewayMachineEnabled,
  setMcpGatewayMachineGrantPreset,
  upsertMcpGatewayProfile,
} from "./McpGatewaySettings";

const providers = [
  {
    instanceId: "opencode",
    driver: "opencode",
    displayName: "OpenCode",
    enabled: true,
    installed: true,
    status: "ready",
    models: [{ slug: "glm-5.3", name: "GLM 5.3", isCustom: false, capabilities: null }],
  },
] as const;

const profile = {
  name: "Andy",
  environmentId: "local",
  providerLabel: "OpenCode",
  modelLabel: "GLM 5.3",
  instanceId: "opencode",
  model: "glm-5.3",
  reasoningEffort: "medium",
  runtimeMode: "full-access",
  interactionMode: "default",
} as const;

const grants = {
  "a534b83f-a352-44d8-aedc-c4230c179390": ["read", "create", "send"] as const,
  "2549ba75-2a91-4554-8baa-88e6ae0efa48": ["read"] as const,
};

const environments = [
  {
    environmentId: "a534b83f-a352-44d8-aedc-c4230c179390",
    label: "Primary",
    connectionState: "connected",
  },
  {
    environmentId: "2549ba75-2a91-4554-8baa-88e6ae0efa48",
    label: "JJ’s MacBook",
    connectionState: "connected",
  },
];

describe("MCP environment grants", () => {
  it("defaults each machine on or off and applies readable grant presets", () => {
    expect(setMcpGatewayMachineEnabled(grants, environments[1]!.environmentId, false)).toEqual({
      [environments[0]!.environmentId]: ["read", "create", "send"],
    });
    expect(setMcpGatewayMachineEnabled({}, environments[1]!.environmentId, true)).toEqual({
      [environments[1]!.environmentId]: ["read", "create", "send"],
    });
    expect(
      setMcpGatewayMachineGrantPreset(grants, environments[1]!.environmentId, "read-send"),
    ).toEqual({
      [environments[0]!.environmentId]: ["read", "create", "send"],
      [environments[1]!.environmentId]: ["read", "send"],
    });
  });

  it("selects every grant for every registered machine", () => {
    expect(selectAllMcpGatewayGrants(environments)).toEqual({
      [environments[0]!.environmentId]: ["read", "create", "send"],
      [environments[1]!.environmentId]: ["read", "create", "send"],
    });
  });

  it("renders one default switch and one dropdown per machine, not scope checkboxes", () => {
    const markup = renderToStaticMarkup(
      <McpEnvironmentGrantMatrix environments={environments} grants={grants} onChange={vi.fn()} />,
    );

    expect(markup).toContain("Select all grants");
    expect(markup).toContain('aria-label="Enable MCP access for Primary"');
    expect(markup).toContain('aria-label="Choose grants for Primary"');
    expect(markup).toContain("Read, create, and send");
    expect(markup).not.toContain("Grant read access to");
    expect(markup).not.toContain("Grant create access to");
    expect(markup).not.toContain("Grant send access to");
  });

  it("keeps persisted grants for unregistered machines visible and revocable", () => {
    const markup = renderToStaticMarkup(
      <McpEnvironmentGrantMatrix
        environments={[]}
        grants={{ "removed-environment": ["read"] }}
        onChange={vi.fn()}
      />,
    );

    expect(markup).toContain("Unavailable machine");
    expect(markup).toContain("removed-environment");
    expect(markup).toContain('aria-label="Enable MCP access for Unavailable machine"');
  });
});

describe("MCP profiles", () => {
  it("creates a route from readable provider and model selections", () => {
    expect(
      createMcpGatewayProfile({
        name: "Andy",
        environmentId: "local",
        provider: providers[0],
        model: providers[0].models[0],
        reasoningEffort: "medium",
        runtimeMode: "full-access",
      }),
    ).toEqual({
      name: "Andy",
      environmentId: "local",
      providerLabel: "OpenCode",
      modelLabel: "GLM 5.3",
      instanceId: "opencode",
      model: "glm-5.3",
      reasoningEffort: "medium",
      runtimeMode: "full-access",
      interactionMode: "default",
    });
  });

  it("offers supported providers and readable models instead of routing-id inputs", () => {
    const markup = renderToStaticMarkup(
      <McpGatewayProfileEditor
        environments={[{ environmentId: "local", label: "Primary", providers }]}
        profiles={[profile]}
        onChange={vi.fn()}
      />,
    );

    expect(markup).toContain("Profile name");
    expect(markup).toContain("OpenCode");
    expect(markup).toContain("GLM 5.3");
    expect(markup).toContain("Medium");
    expect(markup).toContain("Full access");
    expect(markup).toContain("Edit Andy");
    expect(markup).toContain("Remove Andy");
    expect(markup).not.toContain("Provider instance ID");
    expect(markup).not.toContain("Model ID");
  });

  it("updates a named profile without creating a duplicate", () => {
    const next = upsertMcpGatewayProfile([profile], "Andy", {
      ...profile,
      model: "glm-5.4",
      modelLabel: "GLM 5.4",
    });

    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ name: "Andy", modelLabel: "GLM 5.4" });
  });
});
