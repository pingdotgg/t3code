import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments })) as never,
  useEnvironmentProviders: () => providersByEnvironment,
  usePrimaryEnvironmentId: () => primaryId,
}));
// Every environment grants settings writes, so the row's controls are live.
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: (environments) =>
    new Set(environments.map(({ environmentId }) => environmentId)),
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => [],
  useThreadShells: () => [],
}));

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import { SettingsScopeProvider } from "./SettingsScopeContext";

const primaryId = EnvironmentId.make("primary");
const remoteId = EnvironmentId.make("remote");

function provider(driver: string, enabled: boolean, slug: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [
      {
        slug,
        name: slug,
        isCustom: false,
        isDefault: true,
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              options: [
                { id: "medium", label: "Medium", isDefault: true },
                { id: "high", label: "High" },
              ],
            },
          ],
        },
      },
    ],
    slashCommands: [],
    skills: [],
  };
}

const environments = [primaryId, remoteId].map((environmentId) => ({
  environmentId,
  label: environmentId,
  connection: { phase: "connected" },
  serverConfig: {
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    settings: { ...DEFAULT_SERVER_SETTINGS, defaultModelSelection: null },
    environment: { platform: { machine: "server" } },
  },
}));
// Both environments choose their default automatically, but Codex is off on remote.
const providersByEnvironment = new Map([
  [primaryId, [provider("codex", true, "gpt-6"), provider("claudeAgent", true, "claude-opus-5-5")]],
  [remoteId, [provider("codex", false, "gpt-6"), provider("claudeAgent", true, "claude-opus-5-5")]],
]);

describe("ProjectDefaultsSettings", () => {
  it("shows the automatic default model as mixed when environments resolve it differently", async () => {
    await using screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <SettingsScopeProvider search={{}} onChange={() => {}}>
          <ProjectDefaultsSettings category="general" />
        </SettingsScopeProvider>
      </RegistryContext.Provider>,
    );

    await expect.element(screen.getByRole("heading", { name: "Model" })).toBeVisible();
    // Primary alone resolves to Codex at Medium effort; remote can only resolve to Claude.
    expect(
      screen.getByRole("button", { name: "Mixed" }).query(),
      "model picker labelled Mixed",
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Medium" }).query(),
      "effort picker for primary's model",
    ).toBeNull();
  });
});
