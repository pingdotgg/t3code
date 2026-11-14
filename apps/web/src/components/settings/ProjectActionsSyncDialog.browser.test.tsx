import "~/index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ProjectScript,
  type ServerSettings,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";

const state = vi.hoisted(() => ({
  environments: [] as {
    environmentId: EnvironmentId;
    label: string;
    connection: { phase: "connected" | "disconnected" };
    serverConfig: {
      settings: ServerSettings;
      keybindings: typeof DEFAULT_RESOLVED_KEYBINDINGS;
      environment: { platform: { machine: "server" } };
    };
  }[],
  projects: [] as SidebarProjectGroupMember[],
  writable: new Set<EnvironmentId>(),
  updateSettings: vi.fn(),
  upsertKeybinding: vi.fn(),
  removeKeybinding: vi.fn(),
  toast: vi.fn(),
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: state.environments })) as never,
  usePrimaryEnvironmentId: () => sourceId,
  usePrimaryEnvironment: (() => state.environments[0] ?? null) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => state.projects,
  useServerConfigs: (() =>
    new Map(state.environments.map((entry) => [entry.environmentId, entry.serverConfig]))) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentsWithScope: () => state.writable,
  readEnvironmentScope: (id: EnvironmentId) => state.writable.has(id),
  useEnvironmentScope: (id: EnvironmentId | null) => id !== null && state.writable.has(id),
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  usePrimarySettingsAvailable: () => true,
  useClientSettings: ((selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector ? selector(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS) as never,
}));
vi.mock(import("../files/projectFilesQueryState"), async (original) => ({
  ...(await original()),
  getProjectFileQueryAtom: () => missingProjectFile,
}));
vi.mock(import("../../hooks/useT3ProjectFileScripts"), async (original) => ({
  ...(await original()),
  useT3ProjectFileState: () => ({ status: "missing" as const, file: null, scripts: [] }),
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      updateSettings: "updateSettings",
      upsertKeybinding: "upsertKeybinding",
      removeKeybinding: "removeKeybinding",
    } as unknown as typeof actual.serverEnvironment,
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: "updateSettings" | "upsertKeybinding" | "removeKeybinding") =>
    state[command]) as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } };
});

import { ProjectActionsSyncDialog } from "./ProjectActionsSyncDialog";
import { ProjectActionsSettings } from "./ProjectActionsSettings";
import { SettingsScopeProvider } from "./SettingsScopeContext";

const sourceId = EnvironmentId.make("source");
const destinationId = EnvironmentId.make("destination");
const offlineId = EnvironmentId.make("offline");
const projectId = ProjectId.make("same-project-id");
const missingProjectFile = Atom.make(AsyncResult.initial<never, never>());
const sourceScript: ProjectScript = {
  id: "source-dev",
  name: "Dev",
  command: "vp run dev",
  icon: "play",
  runOnWorktreeCreate: false,
  stopOnSettle: true,
};

function setup() {
  vi.clearAllMocks();
  state.projects = [sourceId, destinationId, offlineId].map((environmentId) => ({
    id: projectId,
    environmentId,
    title: "Shared repo",
    workspaceRoot: `/work/${environmentId}/repo`,
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
    environmentLabel: environmentId,
    physicalProjectKey: `${environmentId}:repo`,
  }));
  state.environments = [sourceId, destinationId, offlineId].map((environmentId) => ({
    environmentId,
    label: environmentId,
    connection: { phase: environmentId === offlineId ? "disconnected" : "connected" },
    serverConfig: {
      environment: { platform: { machine: "server" } },
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsOverrides: {
          [projectId]: {
            defaultProjectScripts: [
              {
                ...sourceScript,
                id: environmentId === sourceId ? "source-dev" : "local-dev",
                command: environmentId === sourceId ? sourceScript.command : "old dev",
              },
            ],
            defaultThreadEnvMode: "worktree",
          },
        },
      },
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    },
  }));
  state.writable = new Set([sourceId, destinationId, offlineId]);
  for (const command of [state.updateSettings, state.upsertKeybinding, state.removeKeybinding]) {
    command.mockResolvedValue(AsyncResult.success(undefined));
  }
}

describe("ProjectActionsSyncDialog", () => {
  it.each([sourceId, destinationId])("opens sync when %s is read-only", async (readOnlyId) => {
    setup();
    state.writable.delete(readOnlyId);
    await using screen = await render(
      <SettingsScopeProvider
        search={{ project: "github.com/example/shared-repo" }}
        onChange={vi.fn()}
      >
        <ProjectActionsSettings />
      </SettingsScopeProvider>,
    );
    const sync = screen.getByRole("button", { name: "Sync actions", exact: true });
    expect(sync.element().closest("[inert]")).toBeNull();
    await userEvent.click(sync);
    const dialog = page.getByRole("dialog", { name: "Sync actions" });
    await expect.element(dialog).toBeVisible();
    if (readOnlyId === destinationId) {
      await expect
        .element(dialog.getByRole("button", { name: "Sync actions", exact: true }))
        .toBeDisabled();
      expect(state.updateSettings).not.toHaveBeenCalled();
      await userEvent.click(dialog.getByRole("combobox", { name: "Copy from" }));
      await userEvent.click(page.getByRole("option", { name: "destination · repo" }));
    }
    await userEvent.click(dialog.getByRole("button", { name: "Sync actions", exact: true }));
    await vi.waitFor(() => expect(state.updateSettings).toHaveBeenCalledOnce());
    expect(state.updateSettings.mock.calls[0]![0].environmentId).toBe(
      readOnlyId === sourceId ? destinationId : sourceId,
    );
  });

  it("copies the selected source to connected destinations without changing other settings", async () => {
    setup();
    const onClose = vi.fn();
    await using _screen = await render(
      <ProjectActionsSyncDialog
        group={{ memberProjects: state.projects }}
        initialProjectKey="source:repo"
        onClose={onClose}
      />,
    );
    await expect.element(page.getByText("offline · repo (offline, skipped)")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Sync actions", exact: true }));

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith({
      environmentId: destinationId,
      input: {
        patch: {
          projectSettingsOverrides: {
            [projectId]: {
              defaultThreadEnvMode: "worktree",
              defaultProjectScripts: [{ ...sourceScript, id: "local-dev" }],
            },
          },
        },
      },
    });
    expect(state.upsertKeybinding).not.toHaveBeenCalled();
    expect(state.removeKeybinding).not.toHaveBeenCalled();
  });

  it("lets the source picker reverse direction even when project IDs match across environments", async () => {
    setup();
    await using _screen = await render(
      <ProjectActionsSyncDialog
        group={{ memberProjects: state.projects }}
        initialProjectKey="source:repo"
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(page.getByRole("combobox", { name: "Copy from" }));
    await userEvent.click(page.getByRole("option", { name: "destination · repo" }));
    await userEvent.click(page.getByRole("button", { name: "Sync actions", exact: true }));

    await vi.waitFor(() => expect(state.updateSettings).toHaveBeenCalledOnce());
    expect(state.updateSettings).toHaveBeenCalledWith({
      environmentId: sourceId,
      input: {
        patch: {
          projectSettingsOverrides: {
            [projectId]: expect.objectContaining({
              defaultProjectScripts: [
                expect.objectContaining({ id: "source-dev", command: "old dev" }),
              ],
            }),
          },
        },
      },
    });
  });

  it("rechecks permissions at execution", async () => {
    setup();
    const onClose = vi.fn();
    await using _screen = await render(
      <ProjectActionsSyncDialog
        group={{ memberProjects: state.projects }}
        initialProjectKey="source:repo"
        onClose={onClose}
      />,
    );
    state.writable.delete(destinationId);
    await userEvent.click(page.getByRole("button", { name: "Sync actions", exact: true }));
    expect(state.updateSettings).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("reports a partial copy without claiming success or closing the dialog", async () => {
    setup();
    state.environments[2]!.connection.phase = "connected";
    state.updateSettings
      .mockResolvedValueOnce(AsyncResult.success(undefined))
      .mockResolvedValueOnce(
        AsyncResult.failure(Cause.fail(new Error("Destination disconnected"))),
      );
    const onClose = vi.fn();
    await using _screen = await render(
      <ProjectActionsSyncDialog
        group={{ memberProjects: state.projects }}
        initialProjectKey="source:repo"
        onClose={onClose}
      />,
    );
    await userEvent.click(page.getByRole("button", { name: "Sync actions", exact: true }));
    await vi.waitFor(() => expect(state.updateSettings).toHaveBeenCalledTimes(2));
    expect(onClose).not.toHaveBeenCalled();
    expect(state.toast).not.toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        description: expect.stringContaining("already saved to 1 selected checkouts"),
      }),
    );
  });
});
