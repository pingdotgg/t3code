import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { startClientAppearance } from "../../clientAppearance";
import { writeLocalStorageValue } from "../../hooks/useLocalStorage";
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  updateClientSettings,
} from "../../hooks/useSettings";
import { Dialog, DialogPopup } from "./dialog";

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      getClientSettings: async () => null,
      setClientSettings: async () => undefined,
    },
  }),
}));

function setup(glassOpacity: number) {
  __resetClientSettingsPersistenceForTests();
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    glassOpacity,
    fontFamilyComposer: "Test Composer",
    fontSizePrompt: 19,
  });
  const originalSeparateFonts = localStorage.getItem(TYPOGRAPHY_ADVANCED_STORAGE_KEY);
  localStorage.removeItem(TYPOGRAPHY_ADVANCED_STORAGE_KEY);
  const root = document.documentElement;
  const attributes = ["style", "class", "data-diff-color-scheme", "data-chat-width"].map(
    (name) => ({ name, value: root.getAttribute(name) }),
  );
  const motion = document.createElement("style");
  motion.textContent = '[data-slot="dialog-backdrop"] { transition: none !important; }';
  document.head.append(motion);
  const unsubscribe = startClientAppearance();
  return {
    [Symbol.dispose]() {
      unsubscribe();
      __resetClientSettingsPersistenceForTests();
      motion.remove();
      if (originalSeparateFonts === null) {
        localStorage.removeItem(TYPOGRAPHY_ADVANCED_STORAGE_KEY);
      } else {
        localStorage.setItem(TYPOGRAPHY_ADVANCED_STORAGE_KEY, originalSeparateFonts);
      }
      for (const { name, value } of attributes) {
        if (value === null) root.removeAttribute(name);
        else root.setAttribute(name, value);
      }
    },
  };
}

it.each([80, 100])(
  "applies saved glass opacity %i and updates backdrop filtering without changing dimming",
  async (initialOpacity) => {
    using _appearance = setup(initialOpacity);
    await using _screen = await render(
      <Dialog open>
        <DialogPopup aria-label="Example dialog">Dialog content</DialogPopup>
      </Dialog>,
    );
    await expect.element(page.getByRole("dialog", { name: "Example dialog" })).toBeVisible();
    const backdrop = document.querySelector('[data-slot="dialog-backdrop"]');
    if (!(backdrop instanceof HTMLElement)) throw new Error("Missing dialog backdrop");
    const root = document.documentElement;
    expect(getComputedStyle(backdrop).backdropFilter).toBe(
      initialOpacity === 100 ? "none" : "blur(4px)",
    );

    for (const appearance of ["light", "dark"]) {
      root.classList.toggle("dark", appearance === "dark");
      const tint = getComputedStyle(backdrop).backgroundColor;
      for (const glassOpacity of [100, 95, 100, 80]) {
        await act(() => updateClientSettings({ glassOpacity }));
        const opaque = glassOpacity === 100;
        await vi.waitFor(() =>
          expect(getComputedStyle(backdrop).backdropFilter).toBe(opaque ? "none" : "blur(4px)"),
        );
        expect(root.style.getPropertyValue("--dialog-backdrop-filter")).toBe(opaque ? "none" : "");
        expect(getComputedStyle(backdrop).backgroundColor).toBe(tint);
      }
    }
    for (const separateFonts of [true, false]) {
      await act(() =>
        writeLocalStorageValue(
          TYPOGRAPHY_ADVANCED_STORAGE_KEY,
          separateFonts,
          false,
          Schema.Boolean,
        ),
      );
      expect(root.style.getPropertyValue("--font-size-prompt")).toBe(
        separateFonts ? "19px" : "var(--text-sm)",
      );
      const composerFont = root.style.getPropertyValue("--font-composer");
      if (separateFonts) expect(composerFont).toContain("Test Composer");
      else expect(composerFont).toBe("");
      expect(getComputedStyle(backdrop).backdropFilter).toBe("blur(4px)");
    }
  },
);
