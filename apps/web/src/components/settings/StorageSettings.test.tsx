// @vitest-environment jsdom
import { RegistryProvider } from "@effect/atom-react";
import { DEFAULT_SERVER_SETTINGS, ProjectId, type StorageCleanupReport } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  settings: {} as typeof DEFAULT_SERVER_SETTINGS,
  run: vi.fn(),
}));

vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  const report = Atom.make({ _tag: "Success", value: null, waiting: false });
  const allowed = Atom.make(true);
  return {
    serverEnvironment: {
      storageCleanupReport: () => report,
      runStorageCleanup: { permissionAtom: () => allowed },
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.run }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => {
    const environment = {
      environmentId: "env",
      label: "Machine",
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
  },
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => state.settings,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => vi.fn(),
  useClearScopedSettings: () => vi.fn(),
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => children,
  SettingsSection: ({ children }: { children: ReactNode }) => children,
  SettingsRow: ({ description, control }: { description: ReactNode; control: ReactNode }) => (
    <div>
      {description}
      {control}
    </div>
  ),
  SettingResetButton: () => null,
  useRelativeTimeTick: () => undefined,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { StorageSettingsPanel } from "./StorageSettings";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  state.run.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () =>
    root.render(
      <RegistryProvider>
        <StorageSettingsPanel />
      </RegistryProvider>,
    ),
  );
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Delete now",
  )!;
}

it.each(["machine-wide immediate", "project custom"])(
  "runs cleanup when only %s settled retention is enabled",
  async (scope) => {
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
    const button = await render();

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
  const button = await render();

  expect(button.disabled).toBe(true);
  await act(async () => button.click());
  expect(state.run).not.toHaveBeenCalled();
});
