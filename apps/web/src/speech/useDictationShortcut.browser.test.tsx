import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { useDictationShortcut } from "./useDictationShortcut";

const settings = vi.hoisted(() => ({ mode: "hold" as "auto" | "hold" | "toggle" }));
vi.mock("../hooks/useSettings", () => ({ useClientSettings: () => settings.mode }));

function Probe({ speech }: { speech: Parameters<typeof useDictationShortcut>[0]["speech"] }) {
  useDictationShortcut({
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    speech,
    disabled: false,
    terminalOpen: false,
    modelPickerOpen: false,
  });
  return null;
}

const press = (repeat = false) =>
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "D",
      code: "KeyD",
      ctrlKey: !/Mac/i.test(navigator.platform),
      metaKey: /Mac/i.test(navigator.platform),
      shiftKey: true,
      cancelable: true,
      repeat,
    }),
  );

function setup(available: boolean, mode: typeof settings.mode = "hold") {
  settings.mode = mode;
  return {
    available,
    state: { phase: "idle" as const, error: null, errorAction: null },
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    cancel: vi.fn(),
  };
}

it("leaves the browser shortcut alone when dictation is off", async () => {
  const speech = setup(false);
  await using _screen = await render(<Probe speech={speech} />);
  expect(press()).toBe(true);
  expect(speech.start).not.toHaveBeenCalled();
});

it("stops on a new press when the OS omitted keyup, but ignores autorepeat", async () => {
  const speech = setup(true);
  await using screen = await render(<Probe speech={speech} />);
  expect(press()).toBe(false);
  expect(speech.start).toHaveBeenCalledOnce();
  await screen.rerender(
    <Probe speech={{ ...speech, state: { ...speech.state, phase: "recording" } }} />,
  );
  press(true);
  expect(speech.stop).not.toHaveBeenCalled();
  press();
  expect(speech.stop).toHaveBeenCalledOnce();
});

it.each(["KeyD", "MetaLeft"])(
  "finishes a hold released with %s after startup even if the chord was pressed again while preparing",
  async (code) => {
    const speech = setup(true);
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    let finishStart!: () => void;
    const startup = new Promise<void>((resolve) => {
      finishStart = resolve;
    });
    speech.start.mockReturnValue(startup);
    await using screen = await render(<Probe speech={speech} />);
    press();
    await screen.rerender(
      <Probe speech={{ ...speech, state: { ...speech.state, phase: "preparing" } }} />,
    );
    window.dispatchEvent(new KeyboardEvent("keyup", { code, key: code === "KeyD" ? "D" : "Meta" }));
    press();
    window.dispatchEvent(new KeyboardEvent("keyup", { code, key: code === "KeyD" ? "D" : "Meta" }));
    finishStart();
    await startup;
    expect(speech.start).toHaveBeenCalledOnce();
    expect(speech.stop).toHaveBeenCalledOnce();
  },
);

it.each([
  { mode: "hold", heldMs: 0, stops: true },
  { mode: "auto", heldMs: 300, stops: true },
  { mode: "auto", heldMs: 299, stops: false },
  { mode: "toggle", heldMs: 300, stops: false },
] as const)(
  "handles missing letter keyup in $mode mode after $heldMs ms",
  async ({ mode, heldMs, stops }) => {
    const speech = setup(true, mode);
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    await using screen = await render(<Probe speech={speech} />);
    using now = vi.spyOn(performance, "now").mockReturnValue(0);
    press();
    await screen.rerender(
      <Probe speech={{ ...speech, state: { ...speech.state, phase: "recording" } }} />,
    );
    now.mockReturnValue(heldMs);
    // Neither an unrelated letter nor a modifier outside the chord ends the hold.
    window.dispatchEvent(
      new KeyboardEvent("keyup", { key: "a", code: "KeyA", metaKey: true, shiftKey: true }),
    );
    window.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Alt", code: "AltLeft", metaKey: true, shiftKey: true }),
    );
    await Promise.resolve();
    expect(speech.stop).not.toHaveBeenCalled();

    window.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Meta", code: "MetaLeft", shiftKey: true }),
    );
    await Promise.resolve();
    expect(speech.stop).toHaveBeenCalledTimes(stops ? 1 : 0);

    // Later releases must neither stop twice nor turn an Auto tap into a hold.
    now.mockReturnValue(1_000);
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", code: "ShiftLeft" }));
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "d", code: "KeyD" }));
    await Promise.resolve();
    expect(speech.stop).toHaveBeenCalledTimes(stops ? 1 : 0);
    if (!stops) press();
    expect(speech.stop).toHaveBeenCalledOnce();
  },
);
