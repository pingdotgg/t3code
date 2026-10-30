import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import type { ReactNode } from "react";

import { act, render } from "../../../test/render";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";
import { ThemeColorField } from "./ThemeColorPicker";

const HUE = "Accent color hue";
const PLANE = "Accent color saturation and brightness";

async function renderPicker(ui: ReactNode) {
  await using stack = new AsyncDisposableStack();
  // Synthetic pointer ids are not active pointers, so the browser would reject capture.
  stack.use(vi.spyOn(HTMLElement.prototype, "setPointerCapture").mockImplementation(() => {}));
  const screen = stack.use(await render(ui));
  const environment = stack.move();
  return Object.assign(screen, {
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  });
}

function byLabel<T extends HTMLElement = HTMLElement>(label: string) {
  const element = document.querySelector<T>(`[aria-label="${label}"]`);
  if (!element) throw new Error(`No element labelled ${label}`);
  return element;
}

const slider = (label: string) => byLabel<HTMLInputElement>(label);

async function open(triggerLabel: string) {
  await userEvent.click(byLabel(triggerLabel));
  await vi.waitFor(() => byLabel(HUE));
}

async function press(label: string, key: string, shift = false) {
  const target = slider(label);
  await act(async () => target.focus());
  await userEvent.keyboard(shift ? `{Shift>}{${key}}{/Shift}` : `{${key}}`);
}

function pointer(label: string, type: string, xFraction: number, yFraction = 0.5, pointerId = 1) {
  const target = byLabel(label);
  const bounds = target.getBoundingClientRect();
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      button: 0,
      pointerId,
      clientX: bounds.left + bounds.width * xFraction,
      clientY: bounds.top + bounds.height * yFraction,
    }),
  );
}

async function renderThemeField(value: string) {
  const onChange = vi.fn();
  const field = (current: string) => (
    <ThemeColorField role="accent" value={current} onChange={onChange} />
  );
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await renderPicker(field(value)));
  await open("Choose Accent color color");
  stack.move();
  return Object.assign(screen, {
    onChange,
    echo: (current: string) => screen.rerender(field(current)),
  });
}

describe("theme color field", () => {
  it("keeps the selected hue when a grey color is echoed back from theme settings", async () => {
    await using screen = await renderThemeField("#ff0000");
    const { onChange, echo } = screen;

    await press(HUE, "ArrowRight", true);
    await act(async () => {
      pointer(PLANE, "pointerdown", 0, 0);
      pointer(PLANE, "pointerup", 0, 0);
    });
    expect(onChange).toHaveBeenLastCalledWith("accent", "#ffffff");

    await echo("#ffffff");
    expect(slider(HUE).getAttribute("aria-valuenow")).toBe("10");
  });
});

async function renderAccentPicker(value: string) {
  const onCommit = vi.fn();
  const picker = (current: string) => (
    <ProviderAccentColorPicker displayName="Codex" value={current} onCommit={onCommit} />
  );
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await renderPicker(picker(value)));
  await open("Change accent color for Codex");
  stack.move();
  return Object.assign(screen, {
    onCommit,
    echo: (current: string) => screen.rerender(picker(current)),
  });
}

describe("provider accent color picker", () => {
  it("commits a drag that is still in progress when the popover closes", async () => {
    await using screen = await renderAccentPicker("#ff0000");

    await act(async () => {
      pointer(HUE, "pointerdown", 0.5);
      pointer(HUE, "pointermove", 0.5);
    });
    expect(screen.onCommit).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    expect(screen.onCommit).toHaveBeenCalledTimes(1);
    expect(screen.onCommit.mock.calls[0]?.[0]).not.toBe("#ff0000");
  });

  it("saves a change back to the saved color while the first change is still saving", async () => {
    await using screen = await renderAccentPicker("#ff0000");

    await userEvent.fill(byLabel("Custom hex accent color"), "#00ff00");
    await userEvent.fill(byLabel("Custom hex accent color"), "#ff0000");

    expect(screen.onCommit).toHaveBeenLastCalledWith("#ff0000");
  });

  it("shows the saved color again when it is reverted outside the picker", async () => {
    await using screen = await renderAccentPicker("#ff0000");

    await userEvent.fill(byLabel("Custom hex accent color"), "#00ff00");
    expect(screen.onCommit).toHaveBeenLastCalledWith("#00ff00");
    await screen.echo("#00ff00");
    await screen.echo("#ff0000");

    expect(byLabel("Change accent color for Codex").style.backgroundColor).toBe("rgb(255, 0, 0)");
  });
});
