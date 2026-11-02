import { act, fakeTimers, render, type Screen } from "../../../test/render";
import { RegistryProvider } from "@effect/atom-react";
import { DEFAULT_SERVER_SETTINGS, type StorageCleanupReport } from "@t3tools/contracts";
import { type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  settings: {} as typeof DEFAULT_SERVER_SETTINGS,
  targets: [] as Array<{
    environmentId: string;
    settings: typeof DEFAULT_SERVER_SETTINGS;
    capabilities?: Record<string, boolean>;
  }>,
  offlineEnvironmentIds: [] as string[],
  run: vi.fn(),
  update: vi.fn(),
  report: null as StorageCleanupReport | null,
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const report = Atom.make(() => ({ _tag: "Success", value: state.report, waiting: false }));
  const allowed = Atom.make(true);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      storageCleanupReport: (() => report) as never,
      runStorageCleanup: {
        ...actual.serverEnvironment.runStorageCleanup,
        permissionAtom: () => allowed,
      },
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.run) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => {
    const connectedEnvironments = state.targets.map(
      ({ environmentId, settings, capabilities }) => ({
        environmentId,
        label: environmentId,
        serverConfig: {
          settings,
          environment: {
            capabilities: {
              storageCleanup: true,
              storageCleanupRun: true,
              settledWorktreeCleanup: true,
              worktreesDirectory: true,
              ...capabilities,
            },
          },
        },
      }),
    );
    const offline = state.offlineEnvironmentIds.map((environmentId) => ({
      environmentId,
      label: environmentId,
      serverConfig: null,
    }));
    return {
      scope: { kind: "all" },
      environments: [...connectedEnvironments, ...offline],
      connectedEnvironments,
      targets: state.targets,
      target: null,
    };
  }) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => state.settings) as never,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => state.update,
  useClearScopedSettings: () => vi.fn(),
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsPageContainer: (({ children }: { children: ReactNode }) => children) as never,
  SettingsRow: ({ title, description, status, control, children }) => (
    <div>
      <h3>{title}</h3>
      {description}
      {status && (
        <div
          data-testid={`${title === "Delete old browser artifacts" ? "artifact" : "logs"}-retention-status`}
        >
          {status}
        </div>
      )}
      {control}
      {children}
    </div>
  ),
  SettingResetButton: (() => null) as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: vi.fn() } };
});

import { StorageCleanupSections, WorktreesDirectoryRow } from "./StorageSettings";

function setup() {
  state.settings = {
    ...DEFAULT_SERVER_SETTINGS,
    storageCleanup: {
      worktreeKeepWhen: "uncommitted-changes",
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
      browserArtifactsAfterDays: null,
      logsAfterDays: null,
    },
    projectSettingsOverrides: {},
  };
  state.targets = ["env-a", "env-b"].map((environmentId) => ({
    environmentId,
    settings: state.settings,
  }));
  state.offlineEnvironmentIds = [];
  state.report = null;
  state.run.mockReset();
  state.update.mockReset();
}

function setRepositoryLocationSupport(...support: ReadonlyArray<boolean | undefined>) {
  state.targets = support.map((repositoryWorktreesDirectory, index) => ({
    environmentId: `env-${index}`,
    settings: state.settings,
    capabilities:
      repositoryWorktreesDirectory === undefined ? {} : { repositoryWorktreesDirectory },
  }));
}

function setRetentionValues(
  artifactDays: ReadonlyArray<number | null>,
  logDays: ReadonlyArray<number | null> = artifactDays.map(() => null),
  environmentIds: readonly string[] = ["env-a", "env-b"],
) {
  state.targets = artifactDays.map((browserArtifactsAfterDays, index) => ({
    environmentId: environmentIds[index]!,
    settings: {
      ...state.settings,
      storageCleanup: {
        ...state.settings.storageCleanup,
        browserArtifactsAfterDays,
        logsAfterDays: logDays[index]!,
      },
    },
  }));
  state.settings = state.targets[0]?.settings ?? state.settings;
}

const panel = () => (
  <RegistryProvider>
    <StorageCleanupSections />
  </RegistryProvider>
);
const deleteButton = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Delete now",
  )!;

it("keeps cleanup disabled when settled retention and all other rules are off", async () => {
  setup();
  await using screen = await render(panel());
  const button = deleteButton(screen.container);

  expect(button.disabled).toBe(true);
  await act(async () => button.click());
  expect(state.run).not.toHaveBeenCalled();
});

it("settles mixed retention statuses independently across selected machines", async () => {
  setup();
  using _timers = fakeTimers();
  await using screen = await render(panel());
  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

  await advance(300);
  setRetentionValues([8, null], [8, null]);
  await screen.rerender(panel());
  await advance(125);
  await expect.element(screen.getByTestId("artifact-retention-status")).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("logs-retention-status")).not.toBeInTheDocument();
  setRetentionValues([null, null], [8, null]);
  await screen.rerender(panel());
  await advance(8);
  await expect.element(screen.getByTestId("logs-retention-status")).not.toBeInTheDocument();
  await advance(117);
  await expect.element(screen.getByTestId("logs-retention-status")).not.toBeInTheDocument();
  setRetentionValues([null, null]);
  await screen.rerender(panel());
  await advance(300);
  await expect.element(screen.getByTestId("artifact-retention-status")).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("logs-retention-status")).not.toBeInTheDocument();

  setRetentionValues([8, null]);
  await screen.rerender(panel());
  await advance(300);
  await expect
    .element(screen.getByTestId("artifact-retention-status"))
    .toHaveTextContent("Mixed across selected machines");
  await expect.element(screen.getByTestId("logs-retention-status")).not.toBeInTheDocument();

  setRetentionValues([null, null]);
  await screen.rerender(panel());
  await advance(75);
  await expect
    .element(screen.getByTestId("artifact-retention-status"))
    .toHaveTextContent("Mixed across selected machines");
  setRetentionValues([8, null]);
  await screen.rerender(panel());
  await advance(133);
  await expect
    .element(screen.getByTestId("artifact-retention-status"))
    .toHaveTextContent("Mixed across selected machines");
  setRetentionValues([null, null]);
  await screen.rerender(panel());
  await advance(133);
  await expect
    .element(screen.getByTestId("artifact-retention-status"))
    .toHaveTextContent("Mixed across selected machines");
  await advance(117);
  await expect
    .element(screen.getByTestId("artifact-retention-status"))
    .toHaveTextContent("Mixed across selected machines");
  setRetentionValues([8, null]);
  await screen.rerender(panel());
  await advance(300);
  await expect
    .element(screen.getByTestId("artifact-retention-status"))
    .toHaveTextContent("Mixed across selected machines");

  setRetentionValues([8], [null], ["env-c"]);
  await screen.rerender(panel());
  await expect.element(screen.getByTestId("artifact-retention-status")).not.toBeInTheDocument();

  setRetentionValues([null, null], [null, null], ["env-c", "env-d"]);
  await screen.rerender(panel());
  await expect.element(screen.getByTestId("artifact-retention-status")).not.toBeInTheDocument();

  setRetentionValues([null, null], [8, null]);
  await screen.rerender(panel());
  await advance(300);
  await expect.element(screen.getByTestId("artifact-retention-status")).not.toBeInTheDocument();
  await expect
    .element(screen.getByTestId("logs-retention-status"))
    .toHaveTextContent("Mixed across selected machines");
  setRetentionValues([null, null]);
  await screen.rerender(panel());
  await advance(300);
  await expect.element(screen.getByTestId("logs-retention-status")).not.toBeInTheDocument();
});

const locationRow = () => (
  <RegistryProvider>
    <WorktreesDirectoryRow />
  </RegistryProvider>
);

async function enterLocation(screen: Screen, value: string) {
  const input = screen.getByRole("textbox", { name: "Worktree location" });
  await userEvent.fill(input, value);
  await userEvent.tab();
}

it("refuses relative worktree locations unless every connected server supports them", async () => {
  setup();
  state.settings = { ...state.settings, worktreesDirectory: "/srv/worktrees" };
  setRepositoryLocationSupport(undefined, true);
  await using screen = await render(locationRow());
  const input = screen.getByRole("textbox", { name: "Worktree location" });

  for (const relative of [".claude/worktrees", "C:worktrees", "~worktrees"]) {
    await enterLocation(screen, relative);
    await expect.element(screen.getByRole("alert")).toMatchTextContent(/on env-0 to use/);
    await expect.element(input).toHaveValue(relative);
    await expect.element(input).toHaveAttribute("aria-invalid", "true");
  }
  expect(state.update).not.toHaveBeenCalled();

  for (const absolute of [
    "~/worktrees",
    "~",
    "/tmp/worktrees",
    "D:\\worktrees",
    "\\\\host\\wt",
    "",
  ]) {
    state.update.mockReset();
    await enterLocation(screen, absolute);
    expect(state.update).toHaveBeenCalledExactlyOnceWith({ worktreesDirectory: absolute });
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
    await expect.element(input).not.toHaveAttribute("aria-invalid");
  }

  state.update.mockReset();
  await enterLocation(screen, "'/tmp/my worktrees'");
  await expect.element(input).toHaveValue("/tmp/my worktrees");
  expect(state.update).toHaveBeenCalledExactlyOnceWith({ worktreesDirectory: "/tmp/my worktrees" });
});

it("saves relative worktree locations when every connected server supports them", async () => {
  setup();
  setRepositoryLocationSupport(false);
  await using screen = await render(locationRow());

  await enterLocation(screen, ".claude/worktrees");
  await expect.element(screen.getByRole("alert")).toMatchTextContent(/on env-0 to use/);
  expect(state.update).not.toHaveBeenCalled();

  setRepositoryLocationSupport(true, true);
  state.offlineEnvironmentIds = ["env-offline"];
  await screen.rerender(locationRow());
  await enterLocation(screen, ".claude/worktrees");
  expect(state.update).toHaveBeenCalledExactlyOnceWith({ worktreesDirectory: ".claude/worktrees" });
});
