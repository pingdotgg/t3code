import { act, render } from "../../../test/render";
import { RegistryProvider } from "@effect/atom-react";
import { DEFAULT_SERVER_SETTINGS, type StorageCleanupReport } from "@t3tools/contracts";
import { type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  settings: {} as typeof DEFAULT_SERVER_SETTINGS,
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
  useUpdateScopedSettings: () => state.update,
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
  state.update.mockReset();
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

it("keeps cleanup disabled when settled retention and all other rules are off", async () => {
  setup();
  await using screen = await render(panel());
  const button = deleteButton(screen.container);

  expect(button.disabled).toBe(true);
  await act(async () => button.click());
  expect(state.run).not.toHaveBeenCalled();
});

it("saves a newly enabled retention rule only once its visible age is committed", async () => {
  const label = "Delete inactive worktrees";
  setup();
  await using screen = await render(panel());
  await act(async () =>
    screen.container.querySelector<HTMLElement>(`[role="switch"][aria-label="${label}"]`)!.click(),
  );
  expect(state.update).not.toHaveBeenCalled();

  const input = screen.container.querySelector<HTMLInputElement>(
    `input[aria-label="${label} in days"]`,
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "30");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.blur();
  });
  expect(state.update).toHaveBeenCalledExactlyOnceWith({
    storageCleanup: { worktreeAfterDays: 30 },
  });
});

const inactive = "Delete inactive worktrees";
const ruleSwitch = (root: ParentNode, label: string) =>
  root.querySelector<HTMLElement>(`[role="switch"][aria-label="${label}"]`)!;
const daysInput = (root: ParentNode, label: string) =>
  root.querySelector<HTMLInputElement>(`input[aria-label="${label} in days"]`);
function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
const pressKey = (input: HTMLInputElement, key: string) =>
  input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
async function openDraft(label: string) {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await render(panel()));
  await act(async () => ruleSwitch(screen.container, label).click());
  stack.move();
  return screen;
}

it("saves the visible default when Enter commits an untouched retention draft", async () => {
  setup();
  await using screen = await openDraft(inactive);
  await act(async () => pressKey(daysInput(screen.container, inactive)!, "Enter"));
  expect(state.update).toHaveBeenCalledExactlyOnceWith({
    storageCleanup: { worktreeAfterDays: 8 },
  });
});

it("does not save a retention draft whose visible text is not a number", async () => {
  setup();
  await using screen = await openDraft(inactive);
  const input = daysInput(screen.container, inactive)!;
  for (const text of ["+", "."]) {
    input.select();
    await userEvent.keyboard(`${text}{Enter}`);
    expect(input.value).toBe(text);
  }
  expect(state.update).not.toHaveBeenCalled();
  input.select();
  await userEvent.keyboard("30{Enter}");
  expect(state.update).toHaveBeenCalledExactlyOnceWith({
    storageCleanup: { worktreeAfterDays: 30 },
  });
});

it("still cancels a retention draft left after clicking its days label", async () => {
  setup();
  await using screen = await openDraft(inactive);
  const input = daysInput(screen.container, inactive)!;
  await userEvent.click(input.parentElement!.querySelector("span[aria-hidden]")!);
  const outside = document.createElement("button");
  document.body.append(outside);
  await userEvent.click(outside);
  outside.remove();
  expect(daysInput(screen.container, inactive)).toBeNull();
  expect(state.update).not.toHaveBeenCalled();
});

it("saves a retention step from the drafted age", async () => {
  const label = "Delete old rotated logs";
  setup();
  await using screen = await openDraft(label);
  const step = screen.container.querySelector<HTMLElement>(`[aria-label="Increase ${label}"]`)!;
  await act(async () => step.click());
  expect(state.update).toHaveBeenCalledExactlyOnceWith({ storageCleanup: { logsAfterDays: 9 } });
});

it("returns a retention rule to off when saving its age fails", async () => {
  setup();
  state.update.mockResolvedValue(false);
  await using screen = await openDraft(inactive);
  await act(async () => pressKey(daysInput(screen.container, inactive)!, "Enter"));
  expect(state.update).toHaveBeenCalledOnce();
  expect(daysInput(screen.container, inactive)).toBeNull();
});

it("saves an age edited while an earlier enabling save is pending", async () => {
  setup();
  let failFirst!: (saved: boolean) => void;
  state.update
    .mockReturnValueOnce(new Promise<boolean>((resolve) => (failFirst = resolve)))
    .mockReturnValueOnce(new Promise<boolean>(() => {}));
  await using screen = await openDraft(inactive);
  const input = daysInput(screen.container, inactive)!;
  await act(async () => pressKey(input, "Enter"));
  await act(async () => {
    setInputValue(input, "30");
    input.blur();
  });
  expect(state.update).toHaveBeenNthCalledWith(2, { storageCleanup: { worktreeAfterDays: 30 } });

  await act(async () => failFirst(false));
  await vi.waitFor(() => expect(daysInput(screen.container, inactive)?.value).toBe("30"));
});

it("keeps a retention rule off when its draft is left, cancelled, or switched off", async () => {
  setup();
  await using screen = await openDraft(inactive);
  const outside = document.createElement("button");
  document.body.append(outside);
  await act(async () => outside.focus());
  outside.remove();
  expect(daysInput(screen.container, inactive)).toBeNull();

  await act(async () => ruleSwitch(screen.container, inactive).click());
  await act(async () => pressKey(daysInput(screen.container, inactive)!, "Escape"));
  expect(daysInput(screen.container, inactive)).toBeNull();

  await act(async () => ruleSwitch(screen.container, inactive).click());
  await act(async () => setInputValue(daysInput(screen.container, inactive)!, "30"));
  await act(async () => {
    ruleSwitch(screen.container, inactive).focus();
    ruleSwitch(screen.container, inactive).click();
  });
  expect(daysInput(screen.container, inactive)).toBeNull();
  expect(state.update).not.toHaveBeenCalled();
});

it("turns an enabled retention rule off immediately", async () => {
  const label = "Delete old browser artifacts";
  setup();
  Object.assign(state.settings.storageCleanup, { browserArtifactsAfterDays: 30 });
  await using screen = await render(panel());
  await act(async () => ruleSwitch(screen.container, label).click());
  expect(state.update).toHaveBeenCalledExactlyOnceWith({
    storageCleanup: { browserArtifactsAfterDays: null },
  });
});
