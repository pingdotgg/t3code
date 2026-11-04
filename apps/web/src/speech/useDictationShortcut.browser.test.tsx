import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { useDictationShortcut } from "./useDictationShortcut";

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

function actions(available: boolean) {
  return {
    available,
    state: { phase: "idle" as const, error: null, errorAction: null },
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    cancel: vi.fn(),
  };
}

it("leaves the browser shortcut alone when dictation is off", async () => {
  const speech = actions(false);
  await using _screen = await render(<Probe speech={speech} />);
  expect(press()).toBe(true);
  expect(speech.start).not.toHaveBeenCalled();
});

it("stops on a new press when the OS omitted keyup, but ignores autorepeat", async () => {
  const speech = actions(true);
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
