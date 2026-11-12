import { render } from "../../../test/render";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";

const laptop = EnvironmentId.make("laptop");
const server = EnvironmentId.make("server");

function codexAccount(instanceId: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: {
      status: "authenticated",
      type: "chatgpt",
      email: "gmail@example.test",
      workspaceId: "personal",
    },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [{ slug: "gpt-6-luna", name: "GPT-6 Luna", isCustom: false, capabilities: {} }],
    slashCommands: [],
    skills: [],
  };
}

const providers = new Map([
  [laptop, [codexAccount("codex_laptop_gmail")]],
  [server, [codexAccount("codex_server_gmail")]],
]);

function settingsFor(environmentId: EnvironmentId) {
  return {
    ...DEFAULT_UNIFIED_SETTINGS,
    providerInstances: Object.fromEntries(
      (providers.get(environmentId) ?? []).map((provider) => [
        provider.instanceId,
        { driver: provider.driver },
      ]),
    ),
  };
}

vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    targets: [laptop, server].map((environmentId) => ({
      environmentId,
      projectId: null,
      settings: settingsFor(environmentId),
    })),
  })) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [
      { environmentId: laptop, label: "Laptop", serverConfig: {} },
      { environmentId: server, label: "Server", serverConfig: {} },
    ],
  })) as never,
  useEnvironmentProviders: (() => providers) as never,
}));

import { useScopedModelDisabledReason } from "./useScopedModelAvailability";

function DisabledReason() {
  const reason = useScopedModelDisabledReason(
    settingsFor(laptop),
    deriveProviderInstanceEntries(providers.get(laptop) ?? []),
  )(ProviderInstanceId.make("codex_laptop_gmail"), "gpt-6-luna");
  return <output>{reason ?? "available"}</output>;
}

describe("useScopedModelDisabledReason", () => {
  // Both environments are signed in to the same account under their own instance id.
  it("offers a model every selected environment reaches through the same account", async () => {
    await using screen = await render(<DisabledReason />, { router: false }); // hook only, no routes
    await expect.element(screen.getByRole("status")).toHaveTextContent("available");
  });
});
