import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import {
  getCustomThemes,
  getThemeModes,
  installCustomTheme,
  invalidateCustomThemes,
  parseThemeFile,
  CUSTOM_THEMES_STORAGE_KEY,
} from "../../themePalette";
import { ThemeEditorPanel } from "./ThemeEditorPanel";

function dragHeader(panel: HTMLElement, toX: number, toY: number) {
  const header = panel.querySelector<HTMLElement>("h2")!.closest<HTMLElement>(".cursor-grab")!;
  const rect = panel.getBoundingClientRect();
  const start = { clientX: rect.left + 40, clientY: rect.top + 10 };
  const init = { bubbles: true, button: 0, pointerId: 1 };
  header.dispatchEvent(new PointerEvent("pointerdown", { ...init, ...start }));
  header.dispatchEvent(
    new PointerEvent("pointermove", { ...init, clientX: toX + 40, clientY: toY + 10 }),
  );
  header.dispatchEvent(new PointerEvent("pointerup", init));
}

function dragResizeHandle(panel: HTMLElement, byX: number) {
  const handle = panel.querySelector<HTMLElement>(".cursor-se-resize")!;
  const rect = handle.getBoundingClientRect();
  const init = { bubbles: true, button: 0, pointerId: 2 };
  const start = { clientX: rect.left + 4, clientY: rect.top + 4 };
  handle.dispatchEvent(new PointerEvent("pointerdown", { ...init, ...start }));
  handle.dispatchEvent(
    new PointerEvent("pointermove", {
      ...init,
      clientX: start.clientX + byX,
      clientY: start.clientY,
    }),
  );
  handle.dispatchEvent(new PointerEvent("pointerup", init));
}

function pointerAt(target: HTMLElement, type: string, xFraction: number) {
  const rect = target.getBoundingClientRect();
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      button: 0,
      pointerId: 3,
      clientX: rect.left + rect.width * xFraction,
      clientY: rect.top + rect.height / 2,
    }),
  );
}

async function renderPanel() {
  await page.viewport(1280, 900);
  const stack = new AsyncDisposableStack();
  // Synthetic pointer ids are not active pointers, so the browser would reject capture.
  stack.use(vi.spyOn(HTMLElement.prototype, "setPointerCapture").mockImplementation(() => {}));
  // Tailwind is not loaded here; give the panel its fixed, card-sized box.
  const style = document.head.appendChild(document.createElement("style"));
  style.textContent = "[data-theme-editor-panel]{position:fixed;width:400px;height:300px}";
  stack.defer(() => style.remove());
  const screen = stack.use(
    await render(
      <ThemeEditorPanel
        open
        onOpenChange={() => {}}
        onSaved={() => true}
        editingTheme={null}
        initialAppearance="dark"
        restoreTheme={() => {}}
      />,
    ),
  );
  const panel = screen.getByRole("dialog", { name: "Create theme" });
  await expect.element(panel).toBeVisible();
  return {
    panel: panel.element() as HTMLElement,
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

describe("ThemeEditorPanel", () => {
  it.each(["create", "rename"] as const)(
    "merges a %s draft into a legacy collection theme",
    async (operation) => {
      const previous = localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY);
      localStorage.removeItem(CUSTOM_THEMES_STORAGE_KEY);
      invalidateCustomThemes();
      using _storage = {
        [Symbol.dispose]() {
          if (previous === null) localStorage.removeItem(CUSTOM_THEMES_STORAGE_KEY);
          else localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, previous);
          invalidateCustomThemes();
        },
      };
      const target = installCustomTheme({
        ...parseThemeFile({
          version: 1,
          name: "Legacy",
          appearance: "light",
          colors: { canvas: "#fafafa", accent: "#123456", terminalBackground: "#abcdef" },
        }),
        collection: { id: "open-vsx:demo.theme", label: "Demo" },
      });
      const draft =
        operation === "rename"
          ? installCustomTheme(
              parseThemeFile({
                version: 1,
                name: "Draft",
                appearance: "dark",
                colors: { canvas: "#101010" },
              }),
            )
          : null;
      await using screen = await render(
        <ThemeEditorPanel
          open
          onOpenChange={() => {}}
          onSaved={() => true}
          editingTheme={draft}
          initialAppearance="dark"
          restoreTheme={() => {}}
        />,
      );
      await userEvent.fill(screen.getByRole("textbox", { name: "Theme name" }), "Legacy");
      await userEvent.click(
        screen.getByRole("button", {
          name: operation === "create" ? "Add dark palette" : "Merge into “Legacy”",
        }),
      );
      invalidateCustomThemes();
      const saved = getCustomThemes().find((theme) => theme.id === target.id)!;
      expect(getThemeModes(saved)).toEqual(["light", "dark"]);
      expect(saved.colors).toEqual(target.colors);
      expect(saved.sources?.light?.overrides).toEqual(target.colors);
      expect(saved.collection).toEqual(target.collection);
      expect(saved.sources?.dark).toBeDefined();
      expect(getCustomThemes()).toHaveLength(1);
    },
  );

  it("resets pinned siblings while preserving the imported family color", async () => {
    const previous = localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY);
    using _storage = {
      [Symbol.dispose]() {
        if (previous === null) localStorage.removeItem(CUSTOM_THEMES_STORAGE_KEY);
        else localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, previous);
        invalidateCustomThemes();
      },
    };
    const theme = parseThemeFile({
      version: 1,
      name: "Catppuccin",
      appearance: "dark",
      colors: { canvas: "#1e1e2e", chrome: "#181825", toolbar: "#11111b" },
    });
    const saved = vi.fn((_theme: import("../../themePalette").ThemeDefinition) => true);
    await using screen = await render(
      <ThemeEditorPanel
        open
        onOpenChange={() => {}}
        onSaved={saved}
        editingTheme={null}
        seedTheme={theme}
        seedName="Catppuccin"
        initialAppearance="dark"
        restoreTheme={() => {}}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "2 pinned, reset Background family overrides" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Create theme", exact: true }));
    const result = saved.mock.calls[0]?.[0];
    expect(result?.colors.canvas).toBe(theme.colors.canvas);
    expect(result?.colors.chrome).toBe(theme.colors.canvas);
    expect(result?.colors.toolbar).toBe(theme.colors.canvas);
    expect(result?.sources?.dark?.overrides?.canvas).toBe(theme.colors.canvas);
    expect(result?.sources?.dark?.overrides?.chrome).toBeUndefined();
  });

  it("keeps its left edge when resized after the window shrank", async () => {
    await using view = await renderPanel();
    dragHeader(view.panel, 700, 40);
    await expect.poll(() => view.panel.style.left).toBe("700px");

    await page.viewport(600, 900);
    await expect.poll(() => Number.parseFloat(view.panel.style.left)).toBeLessThan(600);
    const clampedLeft = view.panel.style.left;

    dragResizeHandle(view.panel, -100);
    await expect.poll(() => view.panel.style.width).not.toBe("");
    expect(view.panel.style.left).toBe(clampedLeft);
  });

  it("returns to where the user left it when the window shrinks and grows back", async () => {
    await page.viewport(1280, 900);
    // Synthetic pointer ids are not active pointers, so the browser would reject capture.
    using _capture = vi
      .spyOn(HTMLElement.prototype, "setPointerCapture")
      .mockImplementation(() => {});
    // Tailwind is not loaded here; give the panel its fixed, card-sized box.
    const style = document.head.appendChild(document.createElement("style"));
    style.textContent = "[data-theme-editor-panel]{position:fixed;width:400px;height:300px}";
    using _style = { [Symbol.dispose]: () => style.remove() };
    await using screen = await render(
      <ThemeEditorPanel
        open
        onOpenChange={() => {}}
        onSaved={() => true}
        editingTheme={null}
        initialAppearance="dark"
        restoreTheme={() => {}}
      />,
    );
    const panel = screen.getByRole("dialog", { name: "Create theme" });
    await expect.element(panel).toBeVisible();

    dragHeader(panel.element() as HTMLElement, 700, 40);
    await expect.poll(() => (panel.element() as HTMLElement).style.left).toBe("700px");

    await page.viewport(600, 900);
    await expect
      .poll(() => Number.parseFloat((panel.element() as HTMLElement).style.left))
      .toBeLessThan(600);

    await page.viewport(1280, 900);
    await expect.poll(() => (panel.element() as HTMLElement).style.left).toBe("700px");
  });

  it("restores the colors from before the picker opened when Escape closes it", async () => {
    await using _view = await renderPanel();
    const hex = page.getByRole("textbox", { name: "Accent hex value" });
    const original = (hex.element() as HTMLInputElement).value;
    await userEvent.click(page.getByRole("button", { name: "Choose Accent color" }));
    const hue = page.getByRole("slider", { name: "Accent hue" });
    await expect.element(hue).toBeInTheDocument();
    const hueSlider = hue.element() as HTMLElement;

    await act(async () => {
      pointerAt(hueSlider, "pointerdown", 0.5);
      pointerAt(hueSlider, "pointerup", 0.5);
    });
    await expect.element(hex).not.toHaveValue(original);

    await act(async () => {
      pointerAt(hueSlider, "pointerdown", 0.25);
      hueSlider.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      // The drag keeps going while the picker animates out.
      pointerAt(hueSlider, "pointermove", 0.75);
      pointerAt(hueSlider, "pointerup", 0.75);
    });
    expect((hex.element() as HTMLInputElement).value).toBe(original);
  });
});
