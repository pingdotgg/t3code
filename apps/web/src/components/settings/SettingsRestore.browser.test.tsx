import { RegistryContext } from "@effect/atom-react";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { Project } from "../../types";

const state = vi.hoisted(() => ({
  projects: [] as Project[],
  updateSettings:
    vi.fn<
      (request: {
        environmentId: unknown;
        input: { patch: Record<string, unknown> };
      }) => Promise<unknown>
    >(),
  confirm: vi.fn<() => Promise<boolean>>(),
}));

vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments })) as never,
  usePrimaryEnvironmentId: () => primaryId,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => state.projects) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.updateSettings) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));
vi.mock(import("~/localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: (() => ({ dialogs: { confirm: state.confirm } })) as never,
}));

import { writeBrowserClientSettings } from "../../clientPersistenceStorage";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { useSettingsRestore } from "./SettingsPanels";
import { SettingsScopeProvider } from "./SettingsScopeContext";

const primaryId = EnvironmentId.make("primary");
const remoteId = EnvironmentId.make("remote");
const customized = {
  ...DEFAULT_SERVER_SETTINGS,
  sidebarAutoSettleAfterDays: 30,
  enableProviderUpdateChecks: !DEFAULT_SERVER_SETTINGS.enableProviderUpdateChecks,
};
const environments = [primaryId, remoteId].map((environmentId) => ({
  environmentId,
  label: environmentId,
  connection: { phase: "connected" },
  serverConfig: {
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    settings: customized,
    environment: { platform: { machine: "server" }, capabilities: { projectOrganization: true } },
  },
}));

function setup() {
  vi.clearAllMocks();
  // Browser test files share localStorage, and an earlier file may leave client settings changed.
  writeBrowserClientSettings(DEFAULT_CLIENT_SETTINGS);
  state.projects = [primaryId, remoteId].map((environmentId) => ({
    id: ProjectId.make(`project-${environmentId}`),
    environmentId,
    title: "Shared repo",
    workspaceRoot: `/work/${environmentId}`,
    repositoryIdentity: {
      canonicalKey: "github.com/example/shared-repo",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/example/shared-repo.git",
      },
    },
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  }));
  state.updateSettings.mockResolvedValue(AsyncResult.success(customized));
  state.confirm.mockResolvedValue(true);
  return buildSidebarProjectSnapshots({
    projects: state.projects,
    settings: DEFAULT_CLIENT_SETTINGS,
    primaryEnvironmentId: primaryId,
    resolveEnvironmentLabel: (id) => id,
  })[0]!.projectKey;
}

describe("useSettingsRestore", () => {
  it("restores every environment's defaults under a project scope", async () => {
    const projectKey = setup();
    let restored!: () => void;
    const done = new Promise<void>((resolve) => {
      restored = resolve;
    });
    function RestoreHarness() {
      const { changedSettingLabels, restoreDefaults } = useSettingsRestore(restored);
      return (
        <>
          <p data-testid="labels">{changedSettingLabels.join("|")}</p>
          <button type="button" onClick={() => void restoreDefaults()}>
            Restore device defaults
          </button>
        </>
      );
    }
    await using screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <SettingsScopeProvider search={{ project: projectKey }} onChange={() => {}}>
          <RestoreHarness />
        </SettingsScopeProvider>
      </RegistryContext.Provider>,
    );

    await vi.waitFor(() =>
      expect(screen.getByTestId("labels").element().textContent).toBe(
        "Auto-settle inactive threads|Provider update checks",
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Restore device defaults" }));
    await done;

    expect(
      state.updateSettings.mock.calls.map(([request]) => [
        request.environmentId,
        request.input.patch.sidebarAutoSettleAfterDays,
        request.input.patch.projectSettingsOverrides,
      ]),
    ).toEqual([
      [primaryId, DEFAULT_SERVER_SETTINGS.sidebarAutoSettleAfterDays, undefined],
      [remoteId, DEFAULT_SERVER_SETTINGS.sidebarAutoSettleAfterDays, undefined],
    ]);
  });
});
