import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { act, StrictMode, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ScopedSettingsPatch } from "./scopedSettings";

type WritingStyle = typeof DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle;
const state = vi.hoisted(() => ({
  styles: [] as WritingStyle[],
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    sourceControlWritingStyle: state.styles[0],
  }),
  useScopedSettingsMixed: () => JSON.stringify(state.styles[0]) !== JSON.stringify(state.styles[1]),
  useUpdateScopedSettings: () => state.updateSettings,
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "all", environmentIds: [] },
    environment: null,
    connectedEnvironments: [],
    targets: [],
  }),
}));
vi.mock("./useScopedModelAvailability", () => ({
  useScopedModelDisabledReason: () => () => null,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../../state/server", () => ({ EMPTY_SERVER_PROVIDERS: [] }));
vi.mock("../chat/ProviderModelPicker", () => ({ ProviderModelPicker: () => null }));
vi.mock("./settingsSearch", () => ({ searchableSetting: (id: string) => ({ id, title: id }) }));
vi.mock("./settingsLayout", () => ({
  SETTINGS_PICKER_TRIGGER_CLASSNAME: "",
  SettingResetButton: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button onClick={onClick}>{`Reset ${label}`}</button>
  ),
  SettingsSection: ({ children }: { children: ReactNode }) => children,
  SettingsRow: ({
    children,
    control,
    resetAction,
  }: {
    children: ReactNode;
    control: ReactNode;
    resetAction: ReactNode;
  }) => (
    <div>
      {control}
      {resetAction}
      {children}
    </div>
  ),
}));
vi.mock("../ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => children,
  SelectItem: "span",
  SelectPopup: "div",
  SelectTrigger: "div",
  SelectValue: "span",
}));
vi.mock("../ui/switch", () => ({ Switch: "input" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/button", () => ({ Button: "button" }));

import { SourceControlWritingSettingsSection } from "./SourceControlWritingSettings";

let renderer: ReactTestRenderer | null;

function button(label: string) {
  return renderer!.root.findAllByType("button").find((item) => item.children.includes(label))!;
}

function openEditor() {
  act(() => button("Write custom instructions for all").props.onClick());
}

function editInstructions(value: string) {
  act(() => renderer!.root.findByType("textarea").props.onChange({ target: { value } }));
}

function applyInstructions() {
  act(() => button("Apply instructions to all").props.onClick());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.styles = [
    {
      ...DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle,
      mode: "custom",
      customInstructions: "First environment instructions",
      followChangeRequestTemplates: true,
    },
    {
      ...DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle,
      mode: "custom",
      customInstructions: "Second environment instructions",
      followChangeRequestTemplates: false,
    },
  ];
  state.updateSettings.mockReset().mockImplementation((patch) => {
    state.styles = state.styles.map((style) => ({ ...style, ...patch.sourceControlWritingStyle }));
  });
  act(() => {
    renderer = create(
      <StrictMode>
        <SourceControlWritingSettingsSection />
      </StrictMode>,
    );
  });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("mixed source control instructions", () => {
  it("resets mixed template preferences without replacing each environment's instructions", () => {
    const initialInstructions = state.styles.map(({ mode, customInstructions }) => ({
      mode,
      customInstructions,
    }));

    act(() => button("Reset change request templates").props.onClick());

    expect(state.updateSettings).toHaveBeenCalledTimes(1);
    expect(state.styles.map((style) => style.followChangeRequestTemplates)).toEqual([
      DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle.followChangeRequestTemplates,
      DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle.followChangeRequestTemplates,
    ]);
    expect(
      state.styles.map(({ mode, customInstructions }) => ({ mode, customInstructions })),
    ).toEqual(initialInstructions);
  });

  it("resets every environment even when the representative already has default instructions", () => {
    state.styles[0] = { ...DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle };
    act(() => {
      renderer!.update(
        <StrictMode>
          <SourceControlWritingSettingsSection />
        </StrictMode>,
      );
    });

    act(() => button("Reset source control writing style").props.onClick());

    expect(state.updateSettings).toHaveBeenCalledTimes(1);
    expect(
      state.styles.map(({ mode, customInstructions }) => ({ mode, customInstructions })),
    ).toEqual(
      [0, 1].map(() => ({
        mode: DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle.mode,
        customInstructions: DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle.customInstructions,
      })),
    );
    expect(state.styles[1]!.followChangeRequestTemplates).toBe(false);
  });

  it("does not write an untouched bulk draft", () => {
    const initialStyles = state.styles;
    openEditor();
    expect(renderer!.root.findByType("textarea").props.value).toBe("");
    expect(button("Apply instructions to all").props.disabled).toBe(true);

    applyInstructions();
    expect(state.updateSettings).not.toHaveBeenCalled();
    expect(state.styles).toEqual(initialStyles);
  });

  it("applies edited instructions to every selected environment", () => {
    openEditor();
    editInstructions("  Keep titles concise.  ");
    expect(button("Apply instructions to all").props.disabled).toBe(false);
    applyInstructions();

    expect(state.updateSettings).toHaveBeenCalledTimes(1);
    expect(state.styles.map((style) => style.customInstructions)).toEqual([
      "Keep titles concise.",
      "Keep titles concise.",
    ]);
    expect(state.styles.map((style) => style.followChangeRequestTemplates)).toEqual([true, false]);
  });

  it("allows an intentional clear after editing", () => {
    openEditor();
    editInstructions("Temporary instructions");
    editInstructions("");
    expect(button("Apply instructions to all").props.disabled).toBe(false);
    applyInstructions();

    expect(state.updateSettings).toHaveBeenCalledTimes(1);
    expect(state.styles.map((style) => style.customInstructions)).toEqual(["", ""]);
  });

  it("resets the draft when the bulk editor reopens", () => {
    openEditor();
    editInstructions("Shared instructions");
    applyInstructions();

    // Template preferences still differ, so this row remains mixed after the save.
    openEditor();
    expect(renderer!.root.findByType("textarea").props.value).toBe("");
    expect(button("Apply instructions to all").props.disabled).toBe(true);
    applyInstructions();

    expect(state.updateSettings).toHaveBeenCalledTimes(1);
    expect(state.styles.map((style) => style.customInstructions)).toEqual([
      "Shared instructions",
      "Shared instructions",
    ]);
  });
});
