// @vitest-environment jsdom

import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { ScopedSettingsPatch } from "./scopedSettings";

const state = vi.hoisted(() => ({
  settings: {} as typeof DEFAULT_UNIFIED_SETTINGS,
  receivers: new Set<(settings: typeof DEFAULT_UNIFIED_SETTINGS) => void>(),
  update: vi.fn<(patch: ScopedSettingsPatch) => Promise<boolean>>(),
}));

vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => {
    const [settings, setSettings] = useState(state.settings);
    // Every component reading settings must see pushed values.
    state.receivers.add(setSettings);
    return settings;
  },
  useUpdateScopedSettings: () => state.update,
  useScopedSettingsMixed: () => false,
  useClearScopedSettings: () => vi.fn(),
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "all", environmentIds: [] },
    connectedEnvironments: [],
    targets: [],
    target: null,
  }),
}));
vi.mock("./SettingsScopeNotice", () => ({ SettingsScopeNotice: () => null }));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => children,
  SettingsSection: ({ children }: { children: ReactNode }) => children,
  SettingsRow: ({ control }: { control: ReactNode }) => <div>{control}</div>,
  SettingResetButton: () => null,
  useRelativeTimeTick: () => {},
}));

import { StorageSettingsPanel } from "./StorageSettings";

const rules = [
  { label: "Delete inactive worktrees", key: "worktreeAfterDays" },
  { label: "Delete old browser artifacts", key: "browserArtifactsAfterDays" },
  { label: "Delete old rotated logs", key: "logsAfterDays" },
] as const;

let root: Root;
let container: HTMLDivElement;

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function setup(
  { label, key }: (typeof rules)[number],
  initial: number | null = null,
  { deferred = false } = {},
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.receivers.clear();
  state.settings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    storageCleanup: { ...DEFAULT_UNIFIED_SETTINGS.storageCleanup, [key]: initial },
  };
  const push = (value: number | null) => {
    state.settings = {
      ...state.settings,
      storageCleanup: { ...state.settings.storageCleanup, [key]: value },
    };
    for (const receive of state.receivers) receive(state.settings);
  };
  const saves: { promise: Promise<boolean>; resolve: (saved: boolean) => void }[] = [];
  state.update.mockReset().mockImplementation((patch) => {
    if (deferred) {
      let resolve!: (saved: boolean) => void;
      const promise = new Promise<boolean>((complete) => {
        resolve = complete;
      });
      saves.push({ promise, resolve });
      return promise;
    }
    state.settings = {
      ...state.settings,
      storageCleanup: { ...state.settings.storageCleanup, ...patch.storageCleanup },
    };
    for (const receive of state.receivers) receive(state.settings);
    return Promise.resolve(true);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <>
        <StorageSettingsPanel />
        <button data-testid="outside">Outside</button>
      </>,
    );
  });
  const labelled = (name: string) => {
    const element = container.querySelector<HTMLElement>(`[aria-label="${name}"]`);
    if (!element) throw new Error(`Missing control: ${name}`);
    return element;
  };
  const input = () => {
    const element = labelled(`${label} in days`);
    if (!(element instanceof HTMLInputElement)) throw new Error("Missing days input");
    return element;
  };
  const toggle = labelled(label);
  const click = async (element: HTMLElement) => {
    const mousedown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    await act(async () => {
      element.dispatchEvent(mousedown);
    });
    // Browsers move focus only when mousedown's default action is not prevented.
    if (!mousedown.defaultPrevented) await act(async () => element.focus());
    await act(async () => {
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      element.click();
    });
  };
  const press = async (key: string, element = document.activeElement) => {
    if (!element) throw new Error("Missing focused element");
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    await act(async () => {
      element.dispatchEvent(event);
    });
    return event;
  };
  const replace = async (value: string) => {
    const element = input();
    await act(async () => {
      // Use the native setter so React observes the same input events as typing.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        element,
        value,
      );
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const pointer = (type: "pointerdown" | "pointerup", target: EventTarget) =>
    act(async () => {
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          button: 0,
          buttons: type === "pointerdown" ? 1 : 0,
        }),
      );
    });
  return {
    input,
    toggle,
    clickSwitch: () => click(toggle),
    leave: () => click(container.querySelector<HTMLButtonElement>('[data-testid="outside"]')!),
    press,
    replace,
    async type(value: string) {
      const element = input();
      await act(async () => element.focus());
      for (const next of ["", ...Array.from(value, (_, index) => value.slice(0, index + 1))]) {
        await replace(next);
      }
    },
    async enableWithKeyboard() {
      await act(async () => toggle.focus());
      await press(" ");
      await act(async () => {
        toggle.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true }));
      });
    },
    hold: (direction: "Increase" | "Decrease") =>
      pointer("pointerdown", labelled(`${direction} ${label}`)),
    release: () => pointer("pointerup", window),
    async step(direction: "Increase" | "Decrease") {
      const button = labelled(`${direction} ${label}`);
      await pointer("pointerdown", button);
      await pointer("pointerup", button);
      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      });
    },
    push: (value: number | null) => act(async () => push(value)),
    async finishSave(saved: boolean, index = 0) {
      const save = saves[index];
      if (!save) throw new Error(`Missing pending save: ${index}`);
      await act(async () => {
        save.resolve(saved);
        await save.promise;
      });
    },
    expectOn(value: number) {
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      expect(input().value).toBe(String(value));
    },
    expectOff() {
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      expect(container.querySelector(`[aria-label="${label} in days"]`)).toBeNull();
      expect(toggle.parentElement?.textContent).toContain("Off");
    },
    expectSaved(value: number | null) {
      expect(state.update.mock.calls).toEqual([[{ storageCleanup: { [key]: value } }]]);
    },
  };
}

it.each(rules)("enables and saves $label", async (rule) => {
  const ui = await setup(rule);
  await ui.clickSwitch();
  ui.expectOn(8);
  expect(state.update).not.toHaveBeenCalled();
  await ui.type("30");
  expect(state.update).not.toHaveBeenCalled();
  await ui.press("Enter");
  ui.expectOn(30);
  ui.expectSaved(30);
});

describe("Delete inactive worktrees", () => {
  const rule = rules[0];
  it("enables a focused, selected draft of 8 without saving", async () => {
    const ui = await setup(rule);
    ui.expectOff();
    await ui.clickSwitch();
    ui.expectOn(8);
    expect(document.activeElement).toBe(ui.input());
    expect([ui.input().selectionStart, ui.input().selectionEnd]).toEqual([0, 1]);
    expect(state.update).not.toHaveBeenCalled();
  });

  it("saves only 30 once when typed and accepted with Enter", async () => {
    const ui = await setup(rule);
    await ui.clickSwitch();
    await ui.type("30");
    ui.expectOn(30);
    expect(state.update).not.toHaveBeenCalled();
    await ui.press("Enter");
    ui.expectSaved(30);
    await ui.leave();
    ui.expectOn(30);
    ui.expectSaved(30);
  });

  it("falls back to Off when saving a committed draft fails", async () => {
    const ui = await setup(rule, null, { deferred: true });
    await ui.clickSwitch();
    await ui.type("30");
    await ui.press("Enter");
    ui.expectOn(30);
    ui.expectSaved(30);
    await ui.finishSave(false);
    ui.expectOff();
    ui.expectSaved(30);
  });

  it("keeps the committed age on while waiting for the saved value to arrive", async () => {
    const ui = await setup(rule, null, { deferred: true });
    await ui.clickSwitch();
    await ui.type("30");
    await ui.press("Enter");
    ui.expectOn(30);
    ui.expectSaved(30);
    await ui.finishSave(true);
    ui.expectOn(30);
    ui.expectSaved(30);
    await ui.push(30);
    ui.expectOn(30);
    ui.expectSaved(30);
  });

  it("restores the committed age when clearing the field while saving", async () => {
    const ui = await setup(rule, null, { deferred: true });
    await ui.clickSwitch();
    await ui.type("30");
    await ui.press("Enter");
    ui.expectOn(30);
    ui.expectSaved(30);
    await ui.type("");
    expect(ui.input().value).toBe("");
    await ui.leave();
    ui.expectOn(30);
    ui.expectSaved(30);
    await ui.push(30);
    ui.expectOn(30);
    ui.expectSaved(30);
    await ui.finishSave(true);
    ui.expectOn(30);
    ui.expectSaved(30);
  });

  it("keeps a partially saved age on without a value push and can switch it off", async () => {
    const ui = await setup(rule, null, { deferred: true });
    await ui.clickSwitch();
    await ui.type("30");
    await ui.press("Enter");
    await ui.finishSave(true);
    // Another environment saved, but the representative environment still reports null.
    ui.expectOn(30);
    ui.expectSaved(30);
    await ui.clickSwitch();
    ui.expectOff();
    expect(state.update.mock.calls).toEqual([
      [{ storageCleanup: { [rule.key]: 30 } }],
      [{ storageCleanup: { [rule.key]: null } }],
    ]);
    await ui.finishSave(true, 1);
    ui.expectOff();
    expect(state.update.mock.calls).toEqual([
      [{ storageCleanup: { [rule.key]: 30 } }],
      [{ storageCleanup: { [rule.key]: null } }],
    ]);
  });

  it("saves the untouched visible 8 once on Enter", async () => {
    const ui = await setup(rule);
    await ui.clickSwitch();
    await ui.press("Enter");
    ui.expectSaved(8);
    await ui.leave();
    ui.expectOn(8);
    ui.expectSaved(8);
  });

  it("keeps a draft focused on composing Enter and saves on normal Enter", async ({ skip }) => {
    const ui = await setup(rule);
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    if (!event.isComposing) skip("KeyboardEvent does not support isComposing");
    expect(event.isComposing).toBe(true);
    await ui.clickSwitch();
    await act(async () => {
      ui.input().dispatchEvent(event);
    });
    ui.expectOn(8);
    expect(document.activeElement).toBe(ui.input());
    expect(state.update).not.toHaveBeenCalled();
    await ui.press("Enter");
    ui.expectOn(8);
    ui.expectSaved(8);
  });

  it("leaves composing Escape unconsumed and cancels on normal Escape", async ({ skip }) => {
    const ui = await setup(rule);
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    if (!event.isComposing) skip("KeyboardEvent does not support isComposing");
    expect(event.isComposing).toBe(true);
    await ui.clickSwitch();
    await act(async () => {
      ui.input().dispatchEvent(event);
    });
    ui.expectOn(8);
    expect(event.defaultPrevented).toBe(false);
    expect(state.update).not.toHaveBeenCalled();
    await ui.press("Escape");
    ui.expectOff();
    expect(state.update).not.toHaveBeenCalled();
  });

  it("returns to Off without saving when leaving an untouched draft", async () => {
    const ui = await setup(rule);
    await ui.clickSwitch();
    await ui.leave();
    ui.expectOff();
    expect(state.update).not.toHaveBeenCalled();
  });

  it("saves 30 once when leaving an edited draft", async () => {
    const ui = await setup(rule);
    await ui.clickSwitch();
    await ui.type("30");
    await ui.leave();
    ui.expectOn(30);
    ui.expectSaved(30);
  });

  it("keeps an unparseable draft on Enter and cancels it when leaving without saving", async () => {
    const ui = await setup(rule);
    await ui.clickSwitch();
    await ui.replace("+");
    expect(ui.input().value).toBe("+");
    await ui.press("Enter");
    expect(ui.toggle.getAttribute("aria-checked")).toBe("true");
    expect(ui.input().value).toBe("+");
    expect(document.activeElement).toBe(ui.toggle);
    expect(state.update).not.toHaveBeenCalled();
    await ui.leave();
    ui.expectOff();
    expect(state.update).not.toHaveBeenCalled();
  });

  it("does not save a stale age after replacing valid text with unparseable text", async () => {
    const ui = await setup(rule);
    await ui.clickSwitch();
    await ui.type("30");
    ui.expectOn(30);
    await ui.replace("+");
    expect(ui.input().value).toBe("+");
    expect(state.update).not.toHaveBeenCalled();
    await ui.leave();
    ui.expectOff();
    expect(state.update).not.toHaveBeenCalled();
  });

  it("consumes Escape and cancels an edited draft without saving", async () => {
    const ui = await setup(rule);
    await ui.clickSwitch();
    await ui.type("30");
    const goBack = vi.fn();
    const onKeyDown = vi.fn((event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) goBack();
    });
    window.addEventListener("keydown", onKeyDown);
    try {
      const event = await ui.press("Escape");
      expect(event.defaultPrevented).toBe(true);
      expect(onKeyDown).not.toHaveBeenCalled();
      expect(goBack).not.toHaveBeenCalled();
      ui.expectOff();
      expect(document.activeElement).toBe(ui.toggle);
      expect(state.update).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", onKeyDown);
    }
    await ui.leave();
    ui.expectOff();
    expect(state.update).not.toHaveBeenCalled();
  });

  it.each([
    { unparseable: false, after: "moving focus from an untouched draft" },
    { unparseable: true, after: "unparseable text and Enter" },
  ])("consumes Escape on the switch after $after", async ({ unparseable }) => {
    const ui = await setup(rule);
    await ui.clickSwitch();
    if (unparseable) {
      await ui.replace("+");
      await ui.press("Enter");
      expect(ui.input().value).toBe("+");
    } else {
      await act(async () => ui.toggle.focus());
      ui.expectOn(8);
    }
    expect(document.activeElement).toBe(ui.toggle);
    expect(state.update).not.toHaveBeenCalled();
    const onKeyDown = vi.fn();
    window.addEventListener("keydown", onKeyDown);
    try {
      const event = await ui.press("Escape");
      expect(event.defaultPrevented).toBe(true);
      expect(onKeyDown).not.toHaveBeenCalled();
      ui.expectOff();
      expect(state.update).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", onKeyDown);
    }
  });

  it("ignores a held stepper released after cancelling and opening a fresh draft", async () => {
    const ui = await setup(rule);
    await ui.clickSwitch();
    try {
      await ui.hold("Decrease");
      // The synchronous hold tick proves base-ui installed its window pointerup callback.
      ui.expectOn(7);
      expect(state.update).not.toHaveBeenCalled();
      const event = await ui.press("Escape");
      expect(event.defaultPrevented).toBe(true);
      ui.expectOff();
      expect(state.update).not.toHaveBeenCalled();
      await ui.enableWithKeyboard();
      ui.expectOn(8);
      expect(document.activeElement).toBe(ui.input());
      expect(state.update).not.toHaveBeenCalled();
    } finally {
      await ui.release();
    }
    ui.expectOn(8);
    expect(state.update).not.toHaveBeenCalled();
  });

  it("ignores a held stepper released after unmounting", async () => {
    const ui = await setup(rule);
    await ui.clickSwitch();
    try {
      await ui.hold("Decrease");
      ui.expectOn(7);
      expect(state.update).not.toHaveBeenCalled();
      await act(async () => root.unmount());
    } finally {
      await ui.release();
    }
    expect(state.update).not.toHaveBeenCalled();
  });

  it("cancels an edited draft by switching off without saving", async () => {
    const ui = await setup(rule);
    await ui.clickSwitch();
    await ui.type("30");
    ui.expectOn(30);
    expect(state.update).not.toHaveBeenCalled();
    await ui.clickSwitch();
    ui.expectOff();
    expect(state.update).not.toHaveBeenCalled();
  });

  it("clears a saved draft immediately when switching off before the save arrives", async () => {
    const ui = await setup(rule, null, { deferred: true });
    await ui.clickSwitch();
    await ui.type("30");
    await ui.press("Enter");
    ui.expectOn(30);
    ui.expectSaved(30);
    await ui.clickSwitch();
    ui.expectOff();
    expect(state.update.mock.calls).toEqual([
      [{ storageCleanup: { [rule.key]: 30 } }],
      [{ storageCleanup: { [rule.key]: null } }],
    ]);
    await ui.finishSave(true);
    await ui.finishSave(true, 1);
    ui.expectOff();
    expect(state.update.mock.calls).toEqual([
      [{ storageCleanup: { [rule.key]: 30 } }],
      [{ storageCleanup: { [rule.key]: null } }],
    ]);
  });

  it("saves 30 once when moving focus from the input to the switch", async () => {
    const ui = await setup(rule);
    await ui.clickSwitch();
    await ui.type("30");
    expect(state.update).not.toHaveBeenCalled();
    await act(async () => ui.toggle.focus());
    expect(document.activeElement).toBe(ui.toggle);
    ui.expectOn(30);
    ui.expectSaved(30);
    await ui.leave();
    ui.expectOn(30);
    ui.expectSaved(30);
  });

  it("saves null immediately when switching an existing rule off", async () => {
    const ui = await setup(rule, 30);
    ui.expectOn(30);
    await ui.clickSwitch();
    ui.expectSaved(null);
    ui.expectOff();
  });

  it("cancels an emptied draft when leaving", async () => {
    const ui = await setup(rule);
    await ui.clickSwitch();
    await ui.type("");
    expect(ui.input().value).toBe("");
    await ui.leave();
    ui.expectOff();
    expect(state.update).not.toHaveBeenCalled();
  });

  it.each([
    ["Increase", 9],
    ["Decrease", 7],
  ] as const)("saves the stepped value once on %s", async (direction, value) => {
    const ui = await setup(rule);
    await ui.clickSwitch();
    await ui.step(direction);
    ui.expectOn(value);
    ui.expectSaved(value);
    await ui.leave();
    ui.expectOn(value);
    ui.expectSaved(value);
  });

  it("commits edits to an already enabled rule", async () => {
    const ui = await setup(rule, 8);
    await ui.type("30");
    await ui.leave();
    ui.expectOn(30);
    ui.expectSaved(30);
  });

  it("replaces an untouched draft when a saved value arrives externally", async () => {
    const ui = await setup(rule);
    await ui.clickSwitch();
    ui.expectOn(8);
    expect(state.update).not.toHaveBeenCalled();
    await ui.push(60);
    ui.expectOn(60);
    await ui.leave();
    ui.expectOn(60);
    expect(state.update).not.toHaveBeenCalled();
  });
});
