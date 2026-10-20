import { act, render } from "../../../test/render";
import { RegistryProvider } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ThreadId,
  type StorageCleanupReport,
} from "@t3tools/contracts";
import { type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  settings: {} as typeof DEFAULT_SERVER_SETTINGS,
  run: vi.fn(),
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
    const environment = {
      environmentId: "env",
      label: "Build workstation",
      serverConfig: {
        settings: state.settings,
        environment: {
          capabilities: {
            storageCleanup: true,
            storageCleanupRun: true,
            settledWorktreeCleanup: true,
          },
        },
      },
    };
    return {
      scope: { kind: "environment" },
      environments: [environment],
      connectedEnvironments: [environment],
      targets: [],
      target: null,
    };
  }) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => state.settings) as never,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => vi.fn(),
  useClearScopedSettings: () => vi.fn(),
}));
// The real page container needs a router and the real row reads write permission and
// overrides from live environment state; this suite is about the cleanup panel.
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsPageContainer: (({ children }: { children: ReactNode }) => children) as never,
  SettingsRow: ({ title, description, control, children }) => (
    <div>
      <h3>{title}</h3>
      {description}
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

import { StorageSettingsPanel } from "./StorageSettings";

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
  state.report = null;
  state.run.mockReset();
}

const panel = () => (
  <RegistryProvider>
    <StorageSettingsPanel />
  </RegistryProvider>
);
const deleteButton = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Delete now",
  )!;

it.each(["machine-wide immediate", "project custom"])(
  "runs cleanup when only %s settled retention is enabled",
  async (scope) => {
    setup();
    if (scope === "machine-wide immediate") {
      state.settings = {
        ...state.settings,
        storageCleanup: { ...state.settings.storageCleanup, worktreeSettledAfterDays: 0 },
      };
    } else {
      state.settings = {
        ...state.settings,
        projectSettingsOverrides: {
          [ProjectId.make("project")]: {
            worktreeCleanup: {
              mode: "custom",
              rules: { ...state.settings.storageCleanup, worktreeSettledAfterDays: 7 },
            },
          },
        },
      };
    }
    const report: StorageCleanupReport = {
      trigger: "manual",
      startedAt: "2026-10-14T12:00:00.000Z",
      finishedAt: "2026-10-14T12:00:01.000Z",
      entries: [],
      counts: { removed: 0, kept: 0, failed: 0 },
      omittedCount: 0,
      bytesFreed: 0,
    };
    let complete!: (result: { _tag: "Success"; value: StorageCleanupReport }) => void;
    state.run.mockImplementation(() => new Promise((resolve) => (complete = resolve)));
    await using screen = await render(panel());
    const button = deleteButton(screen.container);

    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(state.run).toHaveBeenCalledExactlyOnceWith({ environmentId: "env", input: {} });
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Deleting…");

    await act(async () => complete({ _tag: "Success", value: report }));
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Delete now");
  },
);

it("keeps cleanup disabled when settled retention and all other rules are off", async () => {
  setup();
  await using screen = await render(panel());
  const button = deleteButton(screen.container);

  expect(button.disabled).toBe(true);
  await act(async () => button.click());
  expect(state.run).not.toHaveBeenCalled();
});

it("shows orphan sizes and identifies failed worktrees with one connected machine", async () => {
  setup();
  state.settings = {
    ...state.settings,
    storageCleanup: { ...state.settings.storageCleanup, worktreeSettledAfterDays: 0 },
  };
  state.report = {
    trigger: "manual",
    startedAt: "2026-10-14T12:00:00.000Z",
    finishedAt: "2026-10-14T12:00:01.000Z",
    entries: [
      {
        kind: "worktree",
        outcome: "kept",
        path: "/worktrees/repo/orphan",
        projectPath: null,
        threadId: null,
        threadTitle: null,
        reason: "No thread uses this folder, and it isn't a git worktree",
        bytes: 6600000,
        files: null,
      },
      {
        kind: "worktree",
        outcome: "failed",
        path: "/worktrees/repo/thread-checkout",
        projectPath: "/projects/repo",
        threadId: ThreadId.make("thread"),
        threadTitle: "Thread title",
        reason: "Git index is locked. Status will resume when the index lock is removed.",
        bytes: null,
        files: null,
      },
    ],
    counts: { removed: 0, kept: 1, failed: 1 },
    omittedCount: 0,
    bytesFreed: 0,
  };
  await using screen = await render(panel());
  const { container } = screen;
  const lastRun = Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Last run"),
  )!;
  await act(async () => lastRun.click());
  const titles = Array.from(container.querySelectorAll("h3"), (heading) => heading.textContent);
  expect(titles).toContain("/worktrees/repo/orphan");
  expect(titles).toContain("thread-checkout");
  const failedRow = page.elementLocator(
    page.getByRole("heading", { name: "thread-checkout", exact: true }).element().parentElement!,
  );
  await expect.element(failedRow.getByText("Build workstation", { exact: true })).toBeVisible();
  await expect.element(failedRow.getByText("/projects/repo", { exact: true })).toBeVisible();
  await expect
    .element(failedRow.getByText("/worktrees/repo/thread-checkout", { exact: true }))
    .toBeVisible();
  await expect.element(failedRow.getByText("Thread title", { exact: true })).toBeVisible();
  await expect
    .element(
      failedRow.getByText(
        "Git index is locked. Status will resume when the index lock is removed.",
        { exact: true },
      ),
    )
    .toBeVisible();
  expect(titles).not.toContain("/worktrees/repo/thread-checkout");
  expect(container.textContent).toContain(
    "No thread uses this folder, and it isn't a git worktree",
  );
  expect(container.textContent).toContain("6.29 MB");
  expect(container.textContent).toContain("0 B recovered.");
});
