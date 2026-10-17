import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import type { ScopedSettingsPatch } from "./scopedSettings";

type WritingStyle = typeof DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle;
const state = vi.hoisted(() => ({
  styles: [] as WritingStyle[],
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => vi.fn()) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    sourceControlWritingStyle: state.styles[0],
  })) as never,
  useScopedSettingsMixed: (keys) =>
    !keys.includes("reviewGuidesEnabled") &&
    JSON.stringify(state.styles[0]) !== JSON.stringify(state.styles[1]),
  useUpdateScopedSettings: () => state.updateSettings,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "all", environmentIds: [] },
    environment: null,
    connectedEnvironments: [],
    targets: state.styles.map((style) => ({
      settings: { ...DEFAULT_UNIFIED_SETTINGS, sourceControlWritingStyle: style },
    })),
    target: null,
  })) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentProviders: () => new Map(),
}));
// The real row reads write permission and overrides from live environment state; this
// suite is about how the section writes mixed writing styles.
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ title, control, resetAction, children }) => (
    <div>
      <h3>{title}</h3>
      {control}
      {resetAction}
      {children}
    </div>
  ),
  SettingsSection: (({ children }: { children: ReactNode }) => children) as never,
}));

import { SourceControlWritingSettingsSection } from "./SourceControlWritingSettings";

let root: Root;
let container: HTMLDivElement;

const resetButton = (label: string) =>
  page.getByRole("button", { name: `Reset ${label} to default` });
const writeForAll = () => page.getByRole("button", { name: "Write custom instructions for all" });
const applyToAll = () => page.getByRole("button", { name: "Apply instructions to all" });
const bulkEditor = () =>
  page.getByRole("textbox", {
    name: "Custom source control instructions for all selected environments",
  });

async function render() {
  await act(async () =>
    root.render(
      <StrictMode>
        <SourceControlWritingSettingsSection />
      </StrictMode>,
    ),
  );
}

beforeEach(async () => {
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
    void render();
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("mixed source control instructions", () => {
  it("resets mixed template preferences without replacing each environment's instructions", async () => {
    const initialInstructions = state.styles.map(({ mode, customInstructions }) => ({
      mode,
      customInstructions,
    }));

    await userEvent.click(resetButton("change request templates"));

    expect(state.updateSettings).toHaveBeenCalledTimes(1);
    expect(state.styles.map((style) => style.followChangeRequestTemplates)).toEqual([
      DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle.followChangeRequestTemplates,
      DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle.followChangeRequestTemplates,
    ]);
    expect(
      state.styles.map(({ mode, customInstructions }) => ({ mode, customInstructions })),
    ).toEqual(initialInstructions);
  });

  it("resets every environment even when the representative already has default instructions", async () => {
    state.styles[0] = { ...DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle };
    await render();

    await userEvent.click(resetButton("source control writing style"));

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

  it("does not write an untouched bulk draft", async () => {
    const initialStyles = state.styles;
    await userEvent.click(writeForAll());
    await expect.element(bulkEditor()).toHaveValue("");
    await expect.element(applyToAll()).toBeDisabled();

    expect(state.updateSettings).not.toHaveBeenCalled();
    expect(state.styles).toEqual(initialStyles);
  });

  it("applies edited instructions to every selected environment", async () => {
    await userEvent.click(writeForAll());
    await userEvent.fill(bulkEditor(), "  Keep titles concise.  ");
    await expect.element(applyToAll()).toBeEnabled();
    await userEvent.click(applyToAll());

    expect(state.updateSettings).toHaveBeenCalledTimes(1);
    expect(state.styles.map((style) => style.customInstructions)).toEqual([
      "Keep titles concise.",
      "Keep titles concise.",
    ]);
    expect(state.styles.map((style) => style.followChangeRequestTemplates)).toEqual([true, false]);
  });

  it("allows an intentional clear after editing", async () => {
    await userEvent.click(writeForAll());
    await userEvent.fill(bulkEditor(), "Temporary instructions");
    await userEvent.clear(bulkEditor());
    await expect.element(applyToAll()).toBeEnabled();
    await userEvent.click(applyToAll());

    expect(state.updateSettings).toHaveBeenCalledTimes(1);
    expect(state.styles.map((style) => style.customInstructions)).toEqual(["", ""]);
  });

  it("shows the plain editor once instructions agree, even while templates differ", async () => {
    await userEvent.click(writeForAll());
    await userEvent.fill(bulkEditor(), "Shared instructions");
    await userEvent.click(applyToAll());

    expect(state.updateSettings).toHaveBeenCalledTimes(1);
    expect(state.styles.map((style) => style.customInstructions)).toEqual([
      "Shared instructions",
      "Shared instructions",
    ]);
    await expect.element(writeForAll()).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("textbox", { name: "Custom source control writing instructions" }))
      .toHaveValue("Shared instructions");
  });
});
