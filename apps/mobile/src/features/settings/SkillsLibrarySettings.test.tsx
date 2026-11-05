import { DEFAULT_SERVER_SETTINGS, type SkillsLibraryStatus } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    targets: [] as ReturnType<typeof environment>[],
    readOnly: new Set<string>(),
    update: vi.fn(),
    refresh: vi.fn(),
    query: vi.fn(),
    refreshStatus: vi.fn(),
    status: {
      libraryPath: "~/.agents/skills",
      linked: [],
      conflicts: [],
      nameMismatches: [],
    } as SkillsLibraryStatus,
  },
}));

vi.mock("react-native", () => ({ View: Children }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/ListActionRow", () => ({
  ListActionRow: ({
    label,
    disabled,
    loading,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    loading?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled || loading} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("./components/SettingsSwitchRow", () => ({
  SettingsSwitchRow: ({
    label,
    subtitle,
    value,
    disabled,
    onValueChange,
  }: {
    label: string;
    subtitle?: string;
    value: boolean;
    disabled?: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <>
      <p>{subtitle}</p>
      <button
        role="switch"
        aria-label={label}
        aria-checked={value}
        disabled={disabled}
        onClick={() => onValueChange(!value)}
      >
        {label}
      </button>
    </>
  ),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { environmentId: string }) => !mocks.readOnly.has(atom.environmentId),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    updateSettings: {
      kind: "update",
      permissionAtom: (environmentId: string) => ({ kind: "permission", environmentId }),
    },
    refreshSkillsLibrary: {
      kind: "refresh",
      permissionAtom: (environmentId: string) => ({ kind: "permission", environmentId }),
    },
    skillsLibraryStatus: (input: { environmentId: string }) => input,
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { kind: string }) =>
    command.kind === "update" ? mocks.update : mocks.refresh,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (input: { environmentId: string }) => {
    mocks.query(input);
    return { data: mocks.status, error: null, refresh: mocks.refreshStatus };
  },
}));

import { SkillsLibrarySettings } from "./SkillsLibrarySettings";
import type { SettingsTarget } from "./settings-environment-filter";

function SkillsLibraries() {
  return mocks.targets.map((target) => (
    <SkillsLibrarySettings
      key={target.environmentId}
      environment={target as unknown as SettingsTarget}
    />
  ));
}

function environment(environmentId: string, supported = true) {
  return {
    environmentId,
    label: environmentId,
    serverConfig: {
      settings: { ...DEFAULT_SERVER_SETTINGS, skillsLibraryEnabled: false },
      environment: { capabilities: { skillsLibrary: supported } },
    },
  };
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.targets = [environment("remote")];
  mocks.readOnly = new Set();
  mocks.update.mockReset();
  mocks.update.mockResolvedValue(AsyncResult.success(undefined));
  mocks.refresh.mockReset();
  mocks.refresh.mockResolvedValue(AsyncResult.success(undefined));
  mocks.query.mockClear();
  mocks.refreshStatus.mockClear();
  mocks.status = { libraryPath: "~/.agents/skills", linked: [], conflicts: [], nameMismatches: [] };
});
afterEach(() => act(() => root.unmount()));

describe("mobile skills library", () => {
  it("can enable and detach the selected environment's library and refresh conflicts", async () => {
    mocks.status = {
      ...mocks.status,
      conflicts: [
        { name: "review", paths: ["~/.claude/skills/review", "~/.agents/skills/review"] },
      ],
    };
    act(() => root.render(<SkillsLibraries />));
    const toggle = container.querySelector<HTMLButtonElement>(
      '[role="switch"][aria-label="Skills library"]',
    );
    expect(toggle).not.toBeNull();
    expect(toggle!.disabled).toBe(false);
    expect(container.textContent).toContain("~/.claude/skills/review");
    await act(async () => toggle!.click());
    expect(mocks.update).toHaveBeenCalledWith({
      environmentId: "remote",
      input: { patch: { skillsLibraryEnabled: true } },
    });
    expect(mocks.refresh).toHaveBeenCalledWith({ environmentId: "remote", input: {} });
    expect(mocks.refreshStatus).toHaveBeenCalled();

    mocks.targets = mocks.targets.map((target) => ({
      ...target,
      serverConfig: {
        ...target.serverConfig,
        settings: { ...target.serverConfig.settings, skillsLibraryEnabled: true },
      },
    }));
    act(() => root.render(<SkillsLibraries />));
    const refresh = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Refresh skills library",
    );
    expect(refresh).toBeDefined();
    mocks.status = { ...mocks.status, conflicts: [] };
    await act(async () => refresh!.click());
    expect(container.textContent).not.toContain("~/.claude/skills/review");
    await act(async () => toggle!.click());
    expect(mocks.update).toHaveBeenLastCalledWith({
      environmentId: "remote",
      input: { patch: { skillsLibraryEnabled: false } },
    });
  });

  it("does not query unsupported environments or let a read-only connection change library files", () => {
    mocks.targets = [environment("old", false), environment("read-only")];
    mocks.targets = mocks.targets.map((target) => ({
      ...target,
      serverConfig: {
        ...target.serverConfig,
        settings: { ...target.serverConfig.settings, skillsLibraryEnabled: true },
      },
    }));
    mocks.readOnly.add("read-only");
    act(() => root.render(<SkillsLibraries />));
    const toggles = container.querySelectorAll<HTMLButtonElement>(
      '[role="switch"][aria-label="Skills library"]',
    );
    expect(toggles).toHaveLength(1);
    expect(toggles[0]!.disabled).toBe(true);
    act(() => toggles[0]!.click());
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.every(([input]) => input.environmentId === "read-only")).toBe(
      true,
    );
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Refresh skills library",
      ),
    ).toBe(false);
  });

  it("keeps refresh available after restoring separate skill folders fails", async () => {
    mocks.targets = mocks.targets.map((target) => ({
      ...target,
      serverConfig: {
        ...target.serverConfig,
        settings: { ...target.serverConfig.settings, skillsLibraryEnabled: true },
      },
    }));
    mocks.refresh.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Disk full"))));
    act(() => root.render(<SkillsLibraries />));
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await act(async () => toggle.click());
    mocks.targets = mocks.targets.map((target) => ({
      ...target,
      serverConfig: {
        ...target.serverConfig,
        settings: { ...target.serverConfig.settings, skillsLibraryEnabled: false },
      },
    }));
    act(() => root.render(<SkillsLibraries />));
    expect(container.textContent).toContain("Disk full");
    const refresh = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Refresh skills library",
    );
    expect(refresh).toBeDefined();
    await act(async () => refresh!.click());
    expect(container.textContent).not.toContain("Disk full");
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  });

  it.each(["update", "refresh"] as const)(
    "reports an unexpected %s rejection and lets the user retry",
    async (command) => {
      mocks[command].mockRejectedValueOnce(new Error("Connection lost"));
      act(() => root.render(<SkillsLibraries />));
      const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
      await act(async () => toggle.click());
      expect(container.textContent).toContain("Connection lost");
      expect(toggle.disabled).toBe(false);

      await act(async () => toggle.click());
      expect(container.textContent).not.toContain("Connection lost");
      expect(toggle.disabled).toBe(false);
      expect(mocks.refreshStatus).toHaveBeenCalled();
    },
  );
});
