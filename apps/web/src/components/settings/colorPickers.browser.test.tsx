import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { useState, type ReactNode } from "react";

import { act, render } from "../../../test/render";
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
  const screen = await renderPicker(field(value));
  await open("Choose Accent color color");
  return Object.assign(screen, {
    onChange,
    echo: (current: string) => screen.rerender(field(current)),
  });
}

function ControlledThemeField() {
  const [value, setValue] = useState("#408080");
  return <ThemeColorField role="accent" value={value} onChange={(_, next) => setValue(next)} />;
}

describe("theme color field", () => {
  it("jumps hue to both endpoints without changing saturation or brightness", async () => {
    await using _screen = await render(<ControlledThemeField />);
    await open("Choose Accent color color");

    await press(HUE, "Home");
    expect(slider(HUE).getAttribute("aria-valuenow")).toBe("0");
    expect(byLabel<HTMLInputElement>("Accent color picker hex value").value).toBe("#804040");

    await press(HUE, "End");
    expect(slider(HUE).getAttribute("aria-valuenow")).toBe("360");
    expect(byLabel<HTMLInputElement>("Accent color picker hex value").value).toBe("#804040");

    await press(HUE, "ArrowRight", true);
    expect(slider(HUE).getAttribute("aria-valuenow")).toBe("10");
    expect(byLabel<HTMLInputElement>("Accent color picker hex value").value).toBe("#804b40");
  });

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
