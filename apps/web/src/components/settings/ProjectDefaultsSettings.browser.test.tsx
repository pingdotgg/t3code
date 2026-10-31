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
  useEnvironments: (() => ({ environments: fixture.environments })) as never,
  useEnvironmentProviders: () => fixture.providersByEnvironment,
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

function provider(driver: string, enabled: boolean, slugs: readonly string[]): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: slugs.map((slug, index) => ({
      slug,
      name: slug,
      isCustom: false,
      isDefault: index === 0,
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
    })),
    slashCommands: [],
    skills: [],
  };
}

interface EnvironmentFixture {
  readonly providers: readonly ServerProvider[];
  readonly hiddenClaudeModels?: readonly string[];
}

const fixture = {
  environments: [] as unknown[],
  providersByEnvironment: new Map<EnvironmentId, readonly ServerProvider[]>(),
};

// Both environments choose their default model automatically.
function setup(primary: EnvironmentFixture, remote: EnvironmentFixture) {
  const byId = new Map([
    [primaryId, primary],
    [remoteId, remote],
  ]);
  fixture.environments = [...byId].map(([environmentId, { hiddenClaudeModels }]) => ({
    environmentId,
    label: environmentId,
    connection: { phase: "connected" },
    serverConfig: {
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        defaultModelSelection: null,
        providerModelPreferences: hiddenClaudeModels
          ? { claudeAgent: { hiddenModels: [...hiddenClaudeModels], modelOrder: [] } }
          : null,
      },
      environment: { platform: { machine: "server" } },
    },
  }));
  fixture.providersByEnvironment = new Map(
    [...byId].map(([environmentId, { providers }]) => [environmentId, providers]),
  );
}

async function renderModelRow() {
  const stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <SettingsScopeProvider search={{}} onChange={() => {}}>
          <ProjectDefaultsSettings category="general" />
        </SettingsScopeProvider>
      </RegistryContext.Provider>,
    ),
  );
  await expect.element(screen.getByRole("heading", { name: "Model" })).toBeVisible();
  stack.move();
  return screen;
}

describe("ProjectDefaultsSettings", () => {
  it("shows the automatic default model as mixed when environments resolve it differently", async () => {
    // Primary alone resolves to Codex at Medium effort; remote can only resolve to Claude.
    setup(
      { providers: [provider("codex", true, ["gpt-6"]), provider("claudeAgent", true, ["opus"])] },
      { providers: [provider("codex", false, ["gpt-6"]), provider("claudeAgent", true, ["opus"])] },
    );
    await using screen = await renderModelRow();

    expect(
      screen.getByRole("button", { name: "Mixed" }).query(),
      "model picker labelled Mixed",
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Medium" }).query(),
      "effort picker for primary's model",
    ).toBeNull();
  });

  it("keeps the shared automatic default editable when environments resolve it alike", async () => {
    // Different catalogs whose defaults are hidden still land on the same visible model.
    setup(
      {
        providers: [provider("claudeAgent", true, ["opus-old", "sonnet"])],
        hiddenClaudeModels: ["opus-old"],
      },
      {
        providers: [provider("claudeAgent", true, ["opus-new", "sonnet"])],
        hiddenClaudeModels: ["opus-new"],
      },
    );
    await using screen = await renderModelRow();

    expect(screen.getByRole("button", { name: "Mixed" }).query(), "Mixed label").toBeNull();
    expect(
      screen.getByRole("button", { name: "Medium" }).query(),
      "effort picker for the shared model",
    ).not.toBeNull();
  });
});
