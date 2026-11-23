import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { getLocalStorageItem, removeLocalStorageItem } from "../../hooks/useLocalStorage";
import { TypographySection } from "./TypographySettings";

const state = vi.hoisted(() => {
  const state = { searchTargetId: null as string | null, fontAccessGranted: false };
  // Installed before the picker module reads font enumeration support at import.
  Object.defineProperty(window, "queryLocalFonts", {
    configurable: true,
    value: async () => {
      if (state.fontAccessGranted) return [{ family: "Test Sans" }];
      throw new DOMException("The local font prompt was dismissed", "NotAllowedError");
    },
  });
  return state;
});

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
  state.fontAccessGranted = false;
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

  it("lists installed fonts when access is granted after a dismissed prompt", async () => {
    using _storage = setup(null);
    await using screen = await render(<TypographySection />);

    await userEvent.click(screen.getByRole("textbox", { name: "Interface font family" }));
    await userEvent.tab();
    state.fontAccessGranted = true;
    await userEvent.click(screen.getByRole("textbox", { name: "Interface font family" }));

    await expect.element(screen.getByRole("option", { name: "Test Sans" })).toBeVisible();
  });
});
