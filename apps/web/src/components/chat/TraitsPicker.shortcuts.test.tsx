// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ResolvedKeybindingsConfig,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { createModelCapabilities } from "@t3tools/shared/model";

import { isEffortPickerOpen } from "../../effortPickerVisibility";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { TraitsMenuContent, TraitsPicker } from "./TraitsPicker";

const KEYBINDINGS = compileResolvedKeybindingsConfig([
  { key: "mod+1", command: "effortPicker.jump.1", when: "effortPickerOpen" },
  { key: "mod+2", command: "effortPicker.jump.2", when: "effortPickerOpen" },
  { key: "mod+3", command: "effortPicker.jump.3", when: "effortPickerOpen" },
]);

// The same jump on a different key depending on whether the composer's terminal is open.
const TERMINAL_KEYBINDINGS = compileResolvedKeybindingsConfig([
  { key: "mod+1", command: "effortPicker.jump.2", when: "effortPickerOpen && terminalOpen" },
  { key: "mod+2", command: "effortPicker.jump.2", when: "effortPickerOpen && !terminalOpen" },
]);

const REASONING: ProviderOptionDescriptor = {
  id: "reasoningEffort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "low", label: "Low", isDefault: true },
    { id: "high", label: "High" },
  ],
};

const SERVICE_TIER: ProviderOptionDescriptor = {
  id: "serviceTier",
  label: "Service tier",
  type: "select",
  options: [
    { id: "default", label: "Standard", isDefault: true },
    { id: "priority", label: "Fast" },
  ],
};

const CLAUDE_EFFORT: ProviderOptionDescriptor = {
  id: "effort",
  label: "Effort",
  type: "select",
  options: [
    { id: "low", label: "Low", isDefault: true },
    { id: "high", label: "High" },
    { id: "ultrathink", label: "Ultrathink" },
  ],
  promptInjectedValues: ["ultrathink"],
};

describe("traits menu effort jumps", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  /** Renders the traits through a real menu owner and opens its menu. */
  async function renderMenu(
    provider: string,
    descriptors: ReadonlyArray<ProviderOptionDescriptor>,
    {
      owner = "traitsPicker",
      prompt = "",
      keybindings = KEYBINDINGS,
      terminalOpen = false,
    }: {
      owner?: "traitsPicker" | "compactMenu";
      prompt?: string;
      keybindings?: ResolvedKeybindingsConfig;
      terminalOpen?: boolean;
    } = {},
  ) {
    const onModelOptionsChange =
      vi.fn<(options: ReadonlyArray<ProviderOptionSelection> | undefined) => void>();
    const onPromptChange = vi.fn<(prompt: string) => void>();
    const models: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "test-model",
        name: "Test model",
        isCustom: false,
        capabilities: createModelCapabilities({ optionDescriptors: descriptors }),
      },
    ];
    const traitsProps = {
      provider: ProviderDriverKind.make(provider),
      models,
      model: "test-model",
      prompt,
      onPromptChange,
      onModelOptionsChange,
      planModeEnabled: false,
      terminalOpen,
      keybindings,
    };
    await act(async () =>
      root.render(
        owner === "traitsPicker" ? (
          <TraitsPicker {...traitsProps} />
        ) : (
          <CompactComposerControlsMenu
            interactionMode="default"
            runtimeMode="full-access"
            runtimeModeOptions={[]}
            showInteractionModeToggle={false}
            onToggleInteractionMode={() => {}}
            onRuntimeModeChange={() => {}}
            renderTraitsMenuContent={(onRequestClose) => (
              <TraitsMenuContent {...traitsProps} onRequestClose={onRequestClose} />
            )}
          />
        ),
      ),
    );
    await act(async () => container.querySelector("button")?.click());
    expect(isEffortPickerOpen()).toBe(true);
    return { onModelOptionsChange, onPromptChange };
  }

  async function press(key: string) {
    const event = new KeyboardEvent("keydown", {
      key,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => document.activeElement?.dispatchEvent(event));
    return event;
  }

  function hintLabels() {
    return Array.from(document.querySelectorAll("kbd"), (kbd) => kbd.textContent);
  }

  it.each(["traitsPicker", "compactMenu"] as const)(
    "numbers only the first group and picks from it, closing the %s",
    async (owner) => {
      const { onModelOptionsChange } = await renderMenu("codex", [REASONING, SERVICE_TIER], {
        owner,
      });
      // mod+3 is bound too, so a third hint would be Service tier's.
      expect(hintLabels()).toEqual(["Ctrl+1", "Ctrl+2"]);

      expect((await press("2")).defaultPrevented).toBe(true);
      expect(onModelOptionsChange).toHaveBeenCalledExactlyOnceWith([
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "default" },
      ]);
      expect(isEffortPickerOpen()).toBe(false);
      expect((await press("2")).defaultPrevented).toBe(false);
    },
  );

  it("re-picks the current level like a click, closing the menu", async () => {
    const { onModelOptionsChange } = await renderMenu("codex", [REASONING]);
    await press("1");
    expect(onModelOptionsChange).toHaveBeenCalledExactlyOnceWith([
      { id: "reasoningEffort", value: "low" },
    ]);
    expect(isEffortPickerOpen()).toBe(false);
  });

  it("ignores numbers past the last option", async () => {
    const { onModelOptionsChange } = await renderMenu("codex", [REASONING]);
    await press("3");
    expect(onModelOptionsChange).not.toHaveBeenCalled();
    expect(isEffortPickerOpen()).toBe(true);
  });

  it("adds Claude's ultrathink prefix like picking it from the menu", async () => {
    const { onModelOptionsChange, onPromptChange } = await renderMenu("claudeAgent", [
      CLAUDE_EFFORT,
    ]);
    await press("3");
    expect(onPromptChange).toHaveBeenCalledExactlyOnceWith("Ultrathink:\n");
    expect(onModelOptionsChange).not.toHaveBeenCalled();
    expect(isEffortPickerOpen()).toBe(false);
  });

  it("leaves Claude's effort locked while the prompt body says ultrathink", async () => {
    const { onModelOptionsChange, onPromptChange } = await renderMenu(
      "claudeAgent",
      [CLAUDE_EFFORT],
      { prompt: "Please ultrathink about this" },
    );
    expect(hintLabels()).toEqual([]);
    // High is a normal option; Ultrathink is the one that edits the prompt.
    await press("2");
    await press("3");
    expect(onModelOptionsChange).not.toHaveBeenCalled();
    expect(onPromptChange).not.toHaveBeenCalled();
    expect(isEffortPickerOpen()).toBe(true);
  });

  it.each([
    { terminalOpen: true, liveKey: "1", deadKey: "2" },
    { terminalOpen: false, liveKey: "2", deadKey: "1" },
  ])(
    "hints and handles the key bound for the terminal state (terminalOpen: $terminalOpen)",
    async ({ terminalOpen, liveKey, deadKey }) => {
      const { onModelOptionsChange } = await renderMenu("codex", [REASONING], {
        keybindings: TERMINAL_KEYBINDINGS,
        terminalOpen,
      });
      expect(hintLabels()).toEqual([`Ctrl+${liveKey}`]);

      expect((await press(deadKey)).defaultPrevented).toBe(false);
      expect(onModelOptionsChange).not.toHaveBeenCalled();
      expect((await press(liveKey)).defaultPrevented).toBe(true);
      expect(onModelOptionsChange).toHaveBeenCalledExactlyOnceWith([
        { id: "reasoningEffort", value: "high" },
      ]);
    },
  );
});
