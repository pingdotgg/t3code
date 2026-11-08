import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { getLocalStorageItem, removeLocalStorageItem } from "../../hooks/useLocalStorage";
import { TypographySection } from "./TypographySettings";

const state = vi.hoisted(() => ({ searchTargetId: null as string | null }));

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
  useUpdateScopedSettings: (() => vi.fn()) as never,
}));
// The previews mount Ghostty and Shiki, which this test does not exercise.
vi.mock(import("./SettingsFontPreviews"), () => ({
  CodeFontPreview: () => <div />,
  PromptFontPreview: () => <div />,
  TerminalFontPreview: () => <div />,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  useSettingsSearchTargetId: () => state.searchTargetId,
}));

function setup(searchTargetId: string | null) {
  state.searchTargetId = searchTargetId;
  removeLocalStorageItem(TYPOGRAPHY_ADVANCED_STORAGE_KEY);
  return { [Symbol.dispose]: () => removeLocalStorageItem(TYPOGRAPHY_ADVANCED_STORAGE_KEY) };
}

describe("TypographySection", () => {
  it("persists the advanced flag the terminal reads when a deep link targets an advanced row", async () => {
    using _storage = setup("terminal-font");
    await using screen = await render(<TypographySection />);

    await expect.element(screen.getByRole("heading", { name: "Terminal font" })).toBeVisible();
    expect(getLocalStorageItem(TYPOGRAPHY_ADVANCED_STORAGE_KEY, Schema.Boolean)).toBe(true);
  });

  it("keeps the typed font family when an IME Escape cancels a conversion", async () => {
    using _storage = setup(null);
    await using screen = await render(<TypographySection />);
    const input = screen.getByRole("textbox", { name: "Interface font family" });
    await input.fill("Noto ゴシック");

    for (const composition of [
      { key: "Escape", isComposing: true, keyCode: 27 },
      { key: "Escape", isComposing: false, keyCode: 229 },
    ]) {
      const event = new KeyboardEvent("keydown", {
        ...composition,
        bubbles: true,
        cancelable: true,
      });
      await act(() => input.element().dispatchEvent(event));
      await expect.element(input).toHaveValue("Noto ゴシック");
    }

    await userEvent.keyboard("{Escape}");
    await expect.element(input).toHaveValue(DEFAULT_UNIFIED_SETTINGS.fontFamilySans);
  });
});
