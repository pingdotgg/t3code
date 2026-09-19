import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  machine: "machine-a",
  project: false,
  update: vi.fn(),
  clear: vi.fn(),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => DEFAULT_UNIFIED_SETTINGS,
  useUpdateScopedSettings: () => state.update,
  useClearScopedSettings: () => state.clear,
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => {
    const target = {
      environmentId: state.machine,
      projectId: state.project ? "project-a" : null,
      settings: DEFAULT_UNIFIED_SETTINGS,
      sources: { worktreeCleanup: "environment" },
    };
    return {
      search: { machine: state.machine, project: state.project ? "project-a" : undefined },
      scope: { kind: state.project ? "project" : "environment", label: state.machine },
      connectedEnvironments: [
        {
          label: state.machine,
          serverConfig: {
            environment: { capabilities: { storageCleanup: true, projectWorktreeCleanup: true } },
          },
        },
      ],
      targets: [target],
      target,
    };
  },
}));
vi.mock("./StorageCleanupPreview", () => ({
  StorageCleanupPreviewPanel: ({ controls }: { controls: Record<string, ReactNode> }) => (
    <div>
      {Object.entries(controls ?? {}).map(([key, control]) => (
        <div key={key}>{control}</div>
      ))}
    </div>
  ),
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => children,
  SettingsSection: ({ children }: { children: ReactNode }) => children,
  SettingsRow: ({ control }: { control: ReactNode }) => control,
}));
vi.mock("./SettingsScopeNotice", () => ({ SettingsScopeNotice: () => null }));
vi.mock("../ui/switch", () => ({ Switch: "input" }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/select", () => ({
  Select: "select",
  SelectItem: "option",
  SelectPopup: "div",
  SelectTrigger: "div",
  SelectValue: "span",
}));
vi.mock("../ui/number-field", () => ({
  NumberField: "div",
  NumberFieldDecrement: "button",
  NumberFieldGroup: "div",
  NumberFieldIncrement: "button",
  NumberFieldInput: "input",
}));

import { StorageSettingsPanel } from "./StorageSettings";

let renderer: ReactTestRenderer;
const toggle = async () => {
  await act(async () =>
    renderer.root
      .findByProps({ "aria-label": "Remove merged worktrees" })
      .props.onCheckedChange(true),
  );
};
const submit = async () => {
  await act(async () =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.props.children === "Save cleanup rules")!
      .props.onClick(),
  );
};
const merged = () => renderer.root.findByProps({ "aria-label": "Remove merged worktrees" });

beforeEach(async () => {
  state.machine = "machine-a";
  state.project = false;
  state.update.mockReset().mockResolvedValue({ failedEnvironments: [], savedEnvironmentCount: 1 });
  state.clear.mockReset();
  await act(async () => {
    renderer = create(<StorageSettingsPanel />);
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
});

describe("saving cleanup rules", () => {
  it("keeps edits local until explicit save and sends only edited rules", async () => {
    await toggle();
    expect(merged().props.checked).toBe(true);
    expect(state.update).not.toHaveBeenCalled();
    await submit();
    expect(state.update).toHaveBeenCalledExactlyOnceWith({
      storageCleanup: { worktreeOnMerge: true },
    });
  });

  it("keeps a committed day-count edit as a draft until Save is activated", async () => {
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "Remove inactive worktrees" })
        .props.onCheckedChange(true),
    );
    await act(async () =>
      renderer.root
        .findAllByType("div")
        .find((node) => typeof node.props.onValueCommitted === "function")!
        .props.onValueCommitted(1),
    );
    expect(state.update).not.toHaveBeenCalled();
    await submit();
    expect(state.update).toHaveBeenCalledExactlyOnceWith({
      storageCleanup: { worktreeAfterDays: 1 },
    });
  });

  it("discards changes without starting cleanup", async () => {
    await toggle();
    await act(async () =>
      renderer.root
        .findAllByType("button")
        .find((button) => button.props.children === "Discard")!
        .props.onClick(),
    );
    expect(merged().props.checked).toBe(false);
    await submit();
    expect(state.update).not.toHaveBeenCalled();
  });

  it("does not carry a draft to a different machine", async () => {
    await toggle();
    state.machine = "machine-b";
    await act(async () => renderer.update(<StorageSettingsPanel />));
    expect(merged().props.checked).toBe(false);
    await submit();
    expect(state.update).not.toHaveBeenCalled();
  });

  it("stages project inheritance changes before persisting them", async () => {
    state.project = true;
    await act(async () => renderer.update(<StorageSettingsPanel />));
    await act(async () => renderer.root.findByType("select").props.onValueChange("off"));
    expect(state.update).not.toHaveBeenCalled();
    expect(state.clear).not.toHaveBeenCalled();
    await submit();
    expect(state.update).toHaveBeenCalledExactlyOnceWith({
      worktreeCleanup: { mode: "off" },
    });
  });

  it("retains drafts after a partial failure so they can be retried", async () => {
    state.update.mockResolvedValueOnce({
      failedEnvironments: [{ label: "machine-a" }],
      savedEnvironmentCount: 1,
    });
    await toggle();
    await submit();
    expect(merged().props.checked).toBe(true);
    await submit();
    expect(state.update).toHaveBeenCalledTimes(2);
  });
});
