import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderInstanceId,
  ProviderDriverKind,
  type McpGatewayProfile,
  type ServerProvider,
} from "@t3tools/contracts";
import { agentMachineUnavailableReason } from "./agentMachineAvailability";

const profile = {
  providerLabel: "OpenCode",
  modelLabel: "deepseek/deepseek-flash",
} as McpGatewayProfile;
const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("opencode"),
  driver: ProviderDriverKind.make("opencode"),
  installed: true,
  version: null,
  auth: { status: "authenticated" },
  checkedAt: "2026-09-11T00:00:00.000Z",
  slashCommands: [],
  skills: [],
  displayName: "OpenCode",
  enabled: true,
  status: "ready",
  models: [
    {
      slug: "deepseek/deepseek-flash",
      name: "DeepSeek Flash",
      isCustom: false,
      capabilities: null,
    },
    {
      slug: "deepseek-api/deepseek-flash",
      name: "DeepSeek Flash",
      isCustom: false,
      capabilities: null,
    },
  ],
};
const environment = (providers: readonly ServerProvider[] = [provider]) =>
  ({
    environmentId: EnvironmentId.make("mac"),
    connection: { phase: "connected" },
    serverConfig: { providers },
  }) as Parameters<typeof agentMachineUnavailableReason>[1];

describe("agent machine availability", () => {
  it("allows the exact DeepSeek route even when display names overlap", () => {
    expect(agentMachineUnavailableReason(profile, environment())).toBeUndefined();
  });
  it("explains an unreachable OpenCode server and recovers when its status refreshes", () => {
    expect(
      agentMachineUnavailableReason(
        profile,
        environment([{ ...provider, status: "error", message: "Could not reach server" }]),
      ),
    ).toContain("Could not reach server");
    expect(agentMachineUnavailableReason(profile, environment())).toBeUndefined();
  });
  it("distinguishes disconnected, excluded, loading, missing, and disabled machines", () => {
    const env = environment();
    expect(
      agentMachineUnavailableReason(profile, {
        ...env,
        connection: { ...env.connection, phase: "offline" },
      }),
    ).toContain("Not connected");
    expect(
      agentMachineUnavailableReason(
        { ...profile, environmentIds: [EnvironmentId.make("windows")] },
        env,
      ),
    ).toContain("Not selected");
    expect(agentMachineUnavailableReason(profile, { ...env, serverConfig: null })).toContain(
      "Loading",
    );
    expect(agentMachineUnavailableReason(profile, environment([]))).toContain("not configured");
    expect(
      agentMachineUnavailableReason(profile, environment([{ ...provider, enabled: false }])),
    ).toContain("disabled");
  });
  it("requires an explicit model when a legacy display name is ambiguous", () => {
    expect(
      agentMachineUnavailableReason({ ...profile, modelLabel: "DeepSeek Flash" }, environment()),
    ).toContain("ambiguous");
    expect(
      agentMachineUnavailableReason(profile, environment([{ ...provider, models: [] }])),
    ).toContain("missing");
  });
  it("supports profiles pinned to an instance without labels", () => {
    expect(
      agentMachineUnavailableReason(
        {
          modelSelection: { instanceId: provider.instanceId, model: "deepseek-api/deepseek-flash" },
        } as McpGatewayProfile,
        environment(),
      ),
    ).toBeUndefined();
  });
});
