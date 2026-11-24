import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import type { ReactNode } from "react";

import { act, render } from "../../../test/render";
import {
  CUSTOM_THEMES_STORAGE_KEY,
  installCustomTheme,
  publishedThemeDefinitions,
  type ThemeDefinition,
} from "../../themePalette";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { ThemeEditorHost } from "./ThemeEditorHost";
import { useThemeEditorStore } from "./themeEditorStore";
import { ThemeEditorPanel } from "./ThemeEditorPanel";

const LOOK = {
  id: "look",
  name: "Look",
  appearance: "dark",
  canvas: "#1a1b26",
  accent: "#7aa2f7",
} as const;

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

async function renderPanel(appContent?: ReactNode) {
  await page.viewport(1280, 900);
  await using stack = new AsyncDisposableStack();
  // Synthetic pointer ids are not active pointers, so the browser would reject capture.
  stack.use(vi.spyOn(HTMLElement.prototype, "setPointerCapture").mockImplementation(() => {}));
  // Tailwind is not loaded here; give the panel its fixed, card-sized box.
  const style = document.head.appendChild(document.createElement("style"));
  style.textContent = "[data-theme-editor-panel]{position:fixed;width:400px;height:300px}";
  stack.defer(() => style.remove());
  const screen = stack.use(
    await render(
      <>
        {appContent}
        <ThemeEditorPanel
          open
          onOpenChange={() => {}}
          onSaved={() => true}
          editingTheme={null}
          initialAppearance="dark"
          restoreTheme={() => {}}
        />
      </>,
    ),
  );
  const panel = screen.getByRole("dialog", { name: "Create theme" });
  await expect.element(panel).toBeVisible();
  const owned = stack.move();
  return {
    panel: panel.element() as HTMLElement,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

// The editor floats beside the Settings dialog, whose Esc handler sits on the document.
async function renderBesideSettings() {
  const onSettingsOpenChange = vi.fn();
  const onEditorOpenChange = vi.fn();
  await using stack = new AsyncDisposableStack();
  stack.use(
    await render(
      <>
        <Dialog onOpenChange={onSettingsOpenChange} open>
          <DialogPopup>
            <DialogTitle>Settings</DialogTitle>
          </DialogPopup>
        </Dialog>
        <ThemeEditorPanel
          open
          onOpenChange={onEditorOpenChange}
          onSaved={() => true}
          editingTheme={null}
          initialAppearance="light"
          restoreTheme={() => {}}
        />
      </>,
    ),
  );
  // Settings moves focus in on a later frame; landing after the test focuses the editor, it steals it.
  await expect.element(page.getByRole("button", { name: "Close" })).toHaveFocus();
  const screen = stack.move();
  return {
    onSettingsOpenChange,
    onEditorOpenChange,
    [Symbol.asyncDispose]: () => screen.disposeAsync(),
  };
}

// The modal Settings dialog marks the editor inert, hiding it from role queries and pointer input.
async function editorElement(selector: string) {
  const query = () => document.querySelector<HTMLElement>(`[data-theme-editor-panel] ${selector}`);
  await expect.poll(query).toBeTruthy();
  return query()!;
}

describe("ThemeEditorPanel", () => {
  it("saves an edit to a published theme to its environment, not to this browser", async () => {
    window.localStorage.removeItem(CUSTOM_THEMES_STORAGE_KEY);
    // A saved theme with the edited name would otherwise turn Save into a merge into it.
    installCustomTheme(publishedThemeDefinitions([{ ...LOOK, id: "dusk", name: "Dusk" }])[0]!);
    const saves: ThemeDefinition[] = [];
    let accept = false;
    const onOpenChange = vi.fn();
    await using screen = await render(
      <ThemeEditorPanel
        open
        onOpenChange={onOpenChange}
        onSaved={() => true}
        onSaveToEnvironment={async (theme) => {
          saves.push(theme);
          return accept;
        }}
        editingTheme={publishedThemeDefinitions([LOOK])[0]!}
        initialAppearance="dark"
        restoreTheme={() => {}}
      />,
    );
    await userEvent.fill(screen.getByRole("textbox", { name: "Theme name" }), "Dusk");
    const save = screen.getByRole("button", { name: "Save changes" });

    await userEvent.click(save);
    await expect.element(screen.getByText("Could not save the theme.")).toBeVisible();
    expect(onOpenChange).not.toHaveBeenCalled();

    accept = true;
    await userEvent.click(save);
    await expect.poll(() => onOpenChange.mock.calls).toEqual([[false]]);
    expect(saves.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "look", label: "Dusk" },
      { id: "look", label: "Dusk" },
    ]);
    expect(
      JSON.parse(window.localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY)!).map(
        (theme: ThemeDefinition) => theme.id,
      ),
    ).toEqual(["dusk"]);
  });

  it("refuses a published theme name longer than its file allows before saving", async () => {
    const onSaveToEnvironment = vi.fn(async () => true);
    await using screen = await render(
      <ThemeEditorPanel
        open
        onOpenChange={() => {}}
        onSaved={() => true}
        onSaveToEnvironment={onSaveToEnvironment}
        editingTheme={publishedThemeDefinitions([LOOK])[0]!}
        initialAppearance="dark"
        restoreTheme={() => {}}
      />,
    );
    await userEvent.fill(screen.getByRole("textbox", { name: "Theme name" }), "x".repeat(49));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await expect
      .element(screen.getByText("A published theme name can be at most 48 characters."))
      .toBeVisible();
    expect(onSaveToEnvironment).not.toHaveBeenCalled();
  });

  it("keeps a published edit in place when its environment is unavailable", async () => {
    const store = useThemeEditorStore.getState();
    const storedThemes = window.localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY);
    store.openThemeEditor({
      editingThemeId: null,
      published: {
        environmentId: EnvironmentId.make("unavailable-environment"),
        theme: publishedThemeDefinitions([LOOK])[0]!,
      },
      seedThemeId: null,
      seedName: null,
      initialAppearance: "dark",
    });
    const sessionId = useThemeEditorStore.getState().session!.id;
    try {
      await using screen = await render(<ThemeEditorHost />);
      const name = screen.getByRole("textbox", { name: "Theme name" });
      await expect.element(name).toHaveValue("Look");
      await userEvent.fill(name, "Unsaved draft");
      await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await expect.element(screen.getByText("Could not save the theme.")).toBeVisible();
      await expect.element(name).toHaveValue("Unsaved draft");
      expect(window.localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY)).toBe(storedThemes);
    } finally {
      store.closeThemeEditor(sessionId);
    }
  });

  it("pauses draft editing while a published save is pending", async () => {
    const onOpenChange = vi.fn();
    const pendingSave = Promise.withResolvers<boolean>();
    await using screen = await render(
      <ThemeEditorPanel
        open
        onOpenChange={onOpenChange}
        onSaved={() => true}
        onSaveToEnvironment={() => pendingSave.promise}
        editingTheme={publishedThemeDefinitions([LOOK])[0]!}
        initialAppearance="dark"
        restoreTheme={() => {}}
      />,
    );
    const name = screen.getByRole("textbox", { name: "Theme name" });
    await userEvent.fill(name, "Draft");
    const save = screen.getByRole("button", { name: "Save changes" });
    await userEvent.click(save);
    await expect.element(save).toBeDisabled();
    (name.element() as HTMLElement).focus();
    await expect.element(name).not.toHaveFocus();

    const cancel = screen.getByRole("button", { name: "Cancel" });
    const close = screen.getByRole("button", { name: "Close the theme editor" });
    await expect.element(cancel).toBeDisabled();
    await expect.element(close).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Minimize the theme editor" }));
    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Expand the theme editor" }));

    pendingSave.resolve(false);
    await expect.element(name).toHaveValue("Draft");
    await expect.element(save).toBeEnabled();
    await userEvent.click(cancel);
    expect(onOpenChange).toHaveBeenCalledWith(false);
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

  it("keeps the typed text while backspacing the background hex past valid shorthand", async () => {
    await using _view = await renderPanel();
    const hex = page.getByRole("textbox", { name: "Background hex value" });
    await userEvent.fill(hex, "#222222");
    await expect.element(hex).toHaveValue("#222222");

    // Four- and three-digit prefixes are valid shorthand; the guided palette must not rewrite them.
    for (const expected of ["#22222", "#2222", "#222", "#22", "#2", "#", ""]) {
      await userEvent.keyboard("{Backspace}");
      await expect.element(hex).toHaveValue(expected);
    }

    await userEvent.keyboard("#3366cc");
    await expect.element(hex).toHaveValue("#3366cc");
    await act(async () => (hex.element() as HTMLInputElement).blur());
    await expect.element(hex).toHaveValue("#3366cc");
  });

  it("commits a typed shorthand hex when inspecting an advanced color switches modes", async () => {
    await using _view = await renderPanel(<div className="bg-sidebar" data-testid="app-sidebar" />);
    await userEvent.click(page.getByRole("button", { name: "Inspect app colors" }));
    await userEvent.fill(page.getByRole("textbox", { name: "Background hex value" }), "#abc");

    // Inspect mode cancels the pointerdown, so the hex field keeps focus while it unmounts.
    const sidebar = page.getByTestId("app-sidebar").element() as HTMLElement;
    await act(async () => pointerAt(sidebar, "pointerdown", 0.5));

    await expect
      .element(page.getByRole("switch", { name: "Use advanced theme colors" }))
      .toBeChecked();
    await expect
      .element(page.getByRole("textbox", { name: "Background hex value" }))
      .toHaveValue("#aabbcc");
  });

  it("closes on Escape without closing Settings", async () => {
    await using view = await renderBesideSettings();
    (await editorElement("input")).focus();
    await userEvent.keyboard("{Escape}");

    expect(view.onEditorOpenChange).toHaveBeenCalledWith(false);
    expect(view.onSettingsOpenChange).not.toHaveBeenCalled();
  });

  it("leaves inspection on Escape without closing the editor or Settings", async () => {
    await using view = await renderBesideSettings();
    (await editorElement('[aria-label="Inspect app colors"]')).click();
    await editorElement('[aria-label="Cancel inspecting app colors"]');
    await userEvent.keyboard("{Escape}");

    await editorElement('[aria-label="Inspect app colors"]');
    expect(view.onEditorOpenChange).not.toHaveBeenCalled();
    expect(view.onSettingsOpenChange).not.toHaveBeenCalled();
  });

  it("closes on a second Escape from the Custom CSS editor without closing Settings", async () => {
    await using view = await renderBesideSettings();
    await editorElement("button[aria-expanded]");
    const cssToggle = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        "[data-theme-editor-panel] button[aria-expanded]",
      ),
    ).find((button) => button.textContent?.includes("Custom CSS"));
    expect(cssToggle).toBeDefined();
    cssToggle!.click();

    const editor = await editorElement('textarea[aria-label="Custom CSS"]');
    editor.focus();
    await userEvent.keyboard("{Escape}");
    editor.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
        repeat: true,
      }),
    );

    expect(view.onEditorOpenChange).not.toHaveBeenCalled();
    expect(view.onSettingsOpenChange).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");

    expect(view.onEditorOpenChange).toHaveBeenCalledWith(false);
    expect(view.onSettingsOpenChange).not.toHaveBeenCalled();
  });
});
