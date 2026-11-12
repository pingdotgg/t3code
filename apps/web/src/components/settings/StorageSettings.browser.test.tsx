import { act, fakeTimers, render, type Screen } from "../../../test/render";
import { RegistryProvider } from "@effect/atom-react";
import { DEFAULT_SERVER_SETTINGS, type StorageCleanupReport } from "@t3tools/contracts";
import { type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const state = vi.hoisted(() => ({
  settings: {} as typeof DEFAULT_SERVER_SETTINGS,
  targets: [] as Array<{ environmentId: string; settings: typeof DEFAULT_SERVER_SETTINGS }>,
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
    const environments = state.targets.map(({ environmentId, settings }) => ({
      environmentId,
      label: environmentId,
      serverConfig: {
        settings,
        environment: {
          capabilities: {
            storageCleanup: true,
            storageCleanupRun: true,
            settledWorktreeCleanup: true,
          },
        },
      },
    }));
    return {
      scope: { kind: "all" },
      environments,
      connectedEnvironments: environments,
      targets: state.targets.map((target) => ({
        ...target,
        sources: { worktreeCleanup: "environment" },
      })),
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

import { StorageCleanupSections, WorktreeCleanupSection } from "./StorageSettings";

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
  state.report = null;
  state.run.mockReset();
  state.update.mockReset();
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
    <WorktreeCleanupSection />
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

const rule = "Delete old browser artifacts";
const ruleSelect = (screen: Screen) => screen.getByRole("combobox", { name: rule });
async function chooseRetention(screen: Screen, option: string) {
  await userEvent.click(ruleSelect(screen));
  await userEvent.click(page.getByRole("option", { name: option, exact: true }));
}
const daysInput = (screen: Screen) => screen.getByLabelText(`${rule} in days`);
const saves = () => state.update.mock.calls.map(([patch]) => patch.storageCleanup);
const failSave = (index: number) => act(() => state.update.mock.calls[index]?.[1]?.onFailed?.());
const withSavedAge = (days: number) => {
  state.settings = {
    ...state.settings,
    storageCleanup: { ...state.settings.storageCleanup, browserArtifactsAfterDays: days },
  };
};

it("saves a newly enabled retention rule only once its age is committed", async () => {
  setup();
  await using screen = await render(panel());
  await chooseRetention(screen, "Custom");
  expect(state.update).not.toHaveBeenCalled();
  await expect.element(ruleSelect(screen)).toHaveTextContent("Custom");
  await expect.element(daysInput(screen)).toHaveFocus();

  await userEvent.fill(daysInput(screen), "30");
  await userEvent.keyboard("{Enter}");
  expect(saves()).toEqual([{ browserArtifactsAfterDays: 30 }]);
  await expect.element(ruleSelect(screen)).toHaveTextContent("Custom");
});

it("discards a retention draft on Escape, on leaving it untouched, or when switched back off", async () => {
  setup();
  await using screen = await render(panel());
  await chooseRetention(screen, "Custom");
  await expect.element(daysInput(screen)).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(ruleSelect(screen)).toHaveTextContent("Off");

  await chooseRetention(screen, "Custom");
  await expect.element(daysInput(screen)).toHaveFocus();
  await userEvent.click(screen.getByRole("heading", { name: rule }));
  await expect.element(ruleSelect(screen)).toHaveTextContent("Off");

  await chooseRetention(screen, "Custom");
  await userEvent.fill(daysInput(screen), "30");
  await chooseRetention(screen, "Off");
  await expect.element(daysInput(screen)).not.toBeInTheDocument();
  await expect.element(ruleSelect(screen)).toHaveTextContent("Off");
  expect(state.update).not.toHaveBeenCalled();
});

it("saves an edited draft when focus leaves its row, not when it reaches the selector", async () => {
  setup();
  await using screen = await render(panel());
  await chooseRetention(screen, "Custom");
  await userEvent.fill(daysInput(screen), "30");
  await userEvent.tab({ shift: true });
  await expect.element(ruleSelect(screen)).toHaveFocus();
  expect(state.update).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("heading", { name: rule }));
  expect(saves()).toEqual([{ browserArtifactsAfterDays: 30 }]);
});

it("saves a stepped first age only once it is committed", async () => {
  setup();
  await using screen = await render(panel());
  await chooseRetention(screen, "Custom");
  await userEvent.keyboard("{ArrowUp}{ArrowUp}");
  await expect.element(daysInput(screen)).toHaveValue(10);
  expect(state.update).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  expect(saves()).toEqual([{ browserArtifactsAfterDays: 10 }]);
});

it("does not save the draft age when Enter is pressed on invalid text", async () => {
  setup();
  await using screen = await render(panel());
  await chooseRetention(screen, "Custom");
  await userEvent.fill(daysInput(screen), "");
  await userEvent.keyboard("{Enter}");
  expect(state.update).not.toHaveBeenCalled();
});

it("switching an edited saved rule off never saves its age afterwards", async () => {
  setup();
  withSavedAge(30);
  await using screen = await render(panel());
  await chooseRetention(screen, "Custom");
  await userEvent.fill(daysInput(screen), "40");
  await chooseRetention(screen, "Off");
  await expect.element(ruleSelect(screen)).toHaveTextContent("Off");
  await userEvent.click(screen.getByRole("heading", { name: rule }));
  expect(saves()).toEqual([{ browserArtifactsAfterDays: null }]);
});

it("returns a newly enabled retention rule to off when its first save fails", async () => {
  setup();
  await using screen = await render(panel());
  await chooseRetention(screen, "Custom");
  await expect.element(daysInput(screen)).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(saves()).toEqual([{ browserArtifactsAfterDays: 8 }]);

  await failSave(0);
  await expect.element(ruleSelect(screen)).toHaveTextContent("Off");
});

it("keeps a newer pending age open when an older first save fails", async () => {
  setup();
  await using screen = await render(panel());
  await chooseRetention(screen, "Custom");
  for (const age of ["30", "60"]) {
    await userEvent.fill(daysInput(screen), age);
    await userEvent.keyboard("{Enter}");
  }
  expect(saves()).toHaveLength(2);

  await failSave(0);
  await expect.element(daysInput(screen)).toHaveValue(60);
  await expect.element(ruleSelect(screen)).toHaveTextContent("Custom");
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

it.each([
  ["worktreeSettledAfterDays", "Delete settled worktrees", true],
  ["worktreeAfterDays", "Delete inactive worktrees", false],
] as const)(
  "edits custom %s retention without saving empty drafts",
  async (key, label, allowsZero) => {
    setup();
    state.settings = {
      ...state.settings,
      storageCleanup: { ...state.settings.storageCleanup, [key]: 2 },
    };
    await using screen = await render(panel());
    const { container } = screen;
    if (allowsZero) {
      await userEvent.click(page.getByRole("button", { name: "Advanced" }));
    }
    const input = container.querySelector<HTMLInputElement>(
      `input[aria-label="${label} in days"]`,
    )!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      input.focus();
      setValue.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.value).toBe("");
    expect(state.update).not.toHaveBeenCalled();
    await act(async () => input.blur());
    expect(input.value).toBe("2");

    await act(async () => {
      input.focus();
      setValue.call(input, "0");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(state.update).not.toHaveBeenCalled();
    await act(async () => input.blur());
    if (allowsZero) {
      expect(state.update).toHaveBeenCalledExactlyOnceWith(
        { storageCleanup: { [key]: 0 } },
        expect.objectContaining({ onFailed: expect.any(Function) }),
      );
      state.update.mockClear();
      await act(async () => {
        input.focus();
        setValue.call(input, "0");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(state.update).not.toHaveBeenCalled();
      await act(async () => {
        setValue.call(input, "20");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(state.update).not.toHaveBeenCalled();
      await act(async () =>
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
      );
      expect(state.update).toHaveBeenCalledExactlyOnceWith(
        { storageCleanup: { [key]: 20 } },
        expect.objectContaining({ onFailed: expect.any(Function) }),
      );
    } else {
      expect(state.update).not.toHaveBeenCalled();
    }
  },
);
