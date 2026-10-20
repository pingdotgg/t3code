import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import type { ReactNode } from "react";

import { act, fakeTimers, render } from "../../../test/render";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";
import { ThemeColorField } from "./ThemeColorPicker";

const HUE = "Accent color hue";
const SATURATION = "Accent color saturation";
const BRIGHTNESS = "Accent color brightness";
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
const sliderValue = (label: string) => Number(slider(label).value);

async function open(triggerLabel: string) {
  await userEvent.click(byLabel(triggerLabel));
  await vi.waitFor(() => byLabel(HUE));
}

async function press(label: string, key: string, shift = false) {
  const target = slider(label);
  await act(async () => target.focus());
  await userEvent.keyboard(shift ? `{Shift>}{${key}}{/Shift}` : `{${key}}`);
}

function setRange(label: string, value: number) {
  const input = slider(label);
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setValue.call(input, String(value));
  input.dispatchEvent(new Event("input", { bubbles: true }));
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

const nextFrame = () =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

async function renderAccent(value: string | undefined, commitDelayMs?: number) {
  const onCommit = vi.fn();
  const screen = await renderPicker(
    <ProviderAccentColorPicker
      displayName="Codex"
      value={value}
      onCommit={onCommit}
      {...(commitDelayMs === undefined ? {} : { commitDelayMs })}
    />,
  );
  await open(`${value ? "Change" : "Add"} accent color for Codex`);
  return Object.assign(screen, { onCommit });
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

describe("provider accent color picker", () => {
  it("adjusts each color axis independently from the keyboard", async () => {
    await using screen = await renderAccent("#ff0000");
    const { onCommit } = screen;

    await press(HUE, "ArrowLeft");
    expect(slider(HUE).getAttribute("aria-valuenow")).toBe("359");
    await press(HUE, "ArrowRight");
    expect(onCommit).toHaveBeenLastCalledWith("#ff0000");

    await press(SATURATION, "ArrowRight", true);
    await press(BRIGHTNESS, "ArrowUp", true);
    expect(onCommit).toHaveBeenLastCalledWith("#ff0000");
    await press(BRIGHTNESS, "ArrowDown", true);
    expect(onCommit).toHaveBeenLastCalledWith("#e60000");
    expect(sliderValue(BRIGHTNESS)).toBe(90);
    expect(slider(BRIGHTNESS).getAttribute("aria-valuetext")).toBe("90%");
    expect(sliderValue(SATURATION)).toBe(100);

    await press(SATURATION, "ArrowDown", true);
    expect(onCommit).toHaveBeenLastCalledWith("#e61717");
    expect(sliderValue(SATURATION)).toBe(90);
    await press(SATURATION, "ArrowUp", true);
    expect(onCommit).toHaveBeenLastCalledWith("#e60000");
    await press(BRIGHTNESS, "ArrowLeft", true);
    expect(onCommit).toHaveBeenLastCalledWith("#cc0000");
    await press(BRIGHTNESS, "ArrowRight", true);
    expect(onCommit).toHaveBeenLastCalledWith("#e60000");

    onCommit.mockClear();
    await press(SATURATION, "Tab");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("supports Home/End and clamps each axis without changing the other", async () => {
    await using screen = await renderAccent("#ff0000");
    const { onCommit } = screen;

    await press(SATURATION, "Home");
    await press(SATURATION, "ArrowLeft");
    expect(sliderValue(SATURATION)).toBe(0);
    expect(onCommit).toHaveBeenLastCalledWith("#ffffff");
    await press(BRIGHTNESS, "Home");
    await press(BRIGHTNESS, "ArrowDown");
    expect(sliderValue(BRIGHTNESS)).toBe(0);
    expect(onCommit).toHaveBeenLastCalledWith("#000000");
    await press(SATURATION, "End");
    expect(sliderValue(SATURATION)).toBe(100);
    expect(sliderValue(BRIGHTNESS)).toBe(0);
    await press(BRIGHTNESS, "End");
    await press(BRIGHTNESS, "ArrowUp");
    expect(onCommit).toHaveBeenLastCalledWith("#ff0000");
    await press(SATURATION, "ArrowLeft");
    expect(sliderValue(SATURATION)).toBe(98);
    expect(onCommit).toHaveBeenLastCalledWith("#ff0505");
  });

  it("adds an accent only after choosing one and clears it back to no accent", async () => {
    await using screen = await renderAccent(undefined);
    const { onCommit } = screen;
    const clearButton = () =>
      [...document.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Clear color"),
      );
    expect(onCommit).not.toHaveBeenCalled();
    expect(clearButton()).toBeUndefined();

    await press(HUE, "ArrowRight", true);
    expect(onCommit).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(clearButton()).toBeDefined());

    await userEvent.click(clearButton()!);
    expect(onCommit).toHaveBeenLastCalledWith("");
    expect(clearButton()).toBeUndefined();
  });

  it("debounces commits and commits the pending color on unmount", async () => {
    await using screen = await renderAccent("#ff0000", 250);
    const { onCommit } = screen;
    using _timers = fakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    await press(HUE, "ArrowRight", true);
    await press(HUE, "ArrowRight", true);
    expect(onCommit).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(250));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("#ff5500");

    await press(HUE, "ArrowRight", true);
    await screen.unmount();
    expect(onCommit).toHaveBeenLastCalledWith("#ff8000");
    await act(async () => vi.advanceTimersByTime(250));
    expect(onCommit).toHaveBeenCalledTimes(2);
  });
});

describe("theme color field", () => {
  it("batches native range changes into one commit per frame and keeps alpha", async () => {
    await using screen = await renderThemeField("#ff000080");
    const { onChange } = screen;

    // Both changes land in one task, so no animation frame can run between them.
    await act(async () => {
      setRange(SATURATION, 50);
      setRange(BRIGHTNESS, 50);
      expect(onChange).not.toHaveBeenCalled();
    });
    await nextFrame();
    expect(onChange).toHaveBeenCalledExactlyOnceWith("accent", "#80404080");

    await press(BRIGHTNESS, "ArrowDown", true);
    await nextFrame();
    expect(onChange).toHaveBeenLastCalledWith("accent", "#66333380");
    expect(sliderValue(SATURATION)).toBe(50);
  });

  it("flushes the final drag color on release of the dragging pointer only", async () => {
    await using screen = await renderThemeField("#ff000080");
    const { onChange } = screen;

    // The drag runs in one task, so no animation frame can commit mid-drag.
    await act(async () => {
      pointer(HUE, "pointerdown", 0.25);
      pointer(HUE, "pointermove", 0.5);
      pointer(HUE, "pointermove", 0.75, 0.5, 2);
      pointer(HUE, "pointerup", 0.75, 0.5, 2);
      expect(onChange).not.toHaveBeenCalled();
      pointer(HUE, "pointerup", 0.5);
    });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("accent", "#00ffff80");
    await act(async () => pointer(HUE, "lostpointercapture", 0.5));
    await nextFrame();
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("clamps out-of-bounds drags and flushes on cancellation and unmount", async () => {
    await using screen = await renderThemeField("#ff000080");
    const { onChange } = screen;

    await act(async () => {
      pointer(PLANE, "pointerdown", -0.5, -0.5);
      pointer(PLANE, "pointercancel", -0.5, -0.5);
    });
    expect(onChange).toHaveBeenLastCalledWith("accent", "#ffffff80");

    await act(async () => {
      pointer(PLANE, "pointerdown", 1.5, 1.5);
      await screen.unmount();
    });
    expect(onChange).toHaveBeenLastCalledWith("accent", "#00000080");
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
