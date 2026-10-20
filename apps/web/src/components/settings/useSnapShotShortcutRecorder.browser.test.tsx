import { act, render } from "../../../test/render";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

const suppress = vi.hoisted(() => vi.fn<(enabled: boolean) => Promise<void>>());
vi.mock(import("../../lib/desktopSnapShot"), async (original) => ({
  ...(await original()),
  getDesktopSnapShotBridge: () => ({ setSnapShotShortcutSuppressed: suppress }) as never,
}));

import { useSnapShotShortcutRecorder } from "./useSnapShotShortcutRecorder";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const recorded = vi.fn();
const error = vi.fn();

function Recorder(props: { allowModifierPairs?: boolean; shortcutLabel?: string }) {
  const recorder = useSnapShotShortcutRecorder({
    shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
    shortcutLabel: props.shortcutLabel,
    allowModifierPairs: props.allowModifierPairs ?? false,
    onRecord: recorded,
    onError: error,
  });
  return recorder.input;
}

function setup() {
  suppress.mockReset().mockResolvedValue(undefined);
  recorded.mockReset();
  error.mockReset();
}
async function renderRecorder(props: Parameters<typeof Recorder>[0] = {}) {
  const screen = await render(<Recorder {...props} />);
  const button = () =>
    screen.container.querySelector<HTMLButtonElement>("[data-keybinding-capture]")!;
  // aria-pressed mirrors the hook's recording state, which flips once suppression resolves.
  const expectRecording = (recording: boolean) =>
    expect.element(screen.getByRole("button")).toHaveAttribute("aria-pressed", String(recording));
  return {
    ...screen,
    button,
    expectRecording,
    async start() {
      await userEvent.click(button());
      await expectRecording(true);
    },
  };
}
const press = (keys: string) => userEvent.keyboard(keys);

it("suppresses capture while recording and uses the physical key for shifted digits", async () => {
  setup();
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  await using screen = await renderRecorder();
  const { button } = screen;
  await screen.start();
  expect(suppress).toHaveBeenCalledExactlyOnceWith(true);
  expect(button().textContent).toBe("Press shortcut…");
  await press("{Control>}{Shift>}2{/Shift}{/Control}");
  expect(recorded).toHaveBeenCalledExactlyOnceWith({
    key: "2",
    modKey: true,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: true,
  });
  expect(suppress).toHaveBeenLastCalledWith(false);
  await screen.expectRecording(false);
});

it("lets users replace an unrecognized desktop label without displaying guessed keys", async () => {
  setup();
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  const shortcutLabel = "Use the shortcut assigned in desktop settings";
  await using screen = await renderRecorder({ shortcutLabel });
  const { button } = screen;
  expect(button().textContent).toBe("Change shortcut");
  expect(button().getAttribute("aria-label")).toBe("Change snapshot shortcut");
  await userEvent.click(button());
  expect(button().textContent).toBe("Press shortcut…");
  await press("{Control>}{Shift>}2{/Shift}{/Control}");
  expect(recorded).toHaveBeenCalledWith(
    expect.objectContaining({ key: "2", modKey: true, shiftKey: true }),
  );
  expect(suppress).toHaveBeenLastCalledWith(false);
});

it("records macOS Command without treating it as Control", async () => {
  setup();
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  _platform.mockReturnValue("MacIntel");
  await using screen = await renderRecorder({ allowModifierPairs: true });

  await screen.start();
  await press("{Meta>}k{/Meta}");
  expect(recorded).toHaveBeenCalledWith(expect.objectContaining({ key: "k", modKey: true }));
});

it.each(["Escape", "blur", "unmount"])("cancels on %s without selecting keys", async (cancel) => {
  setup();
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  await using screen = await renderRecorder();
  const { button } = screen;
  await screen.start();
  if (cancel === "Escape") {
    const outside = vi.fn();
    document.addEventListener("keydown", outside);
    using _listener = { [Symbol.dispose]: () => document.removeEventListener("keydown", outside) };
    await press("{Escape}");
    expect(outside).not.toHaveBeenCalled();
  } else if (cancel === "blur") await act(async () => button().blur());
  else await screen.unmount();
  expect(suppress).toHaveBeenLastCalledWith(false);
  expect(recorded).not.toHaveBeenCalled();
  if (cancel !== "unmount") await screen.expectRecording(false);
});

it("ignores late suppression acknowledgements after cancellation", async () => {
  setup();
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  const pending = deferred<void>();
  suppress.mockImplementation((enabled) => (enabled ? pending.promise : Promise.resolve()));
  await using screen = await renderRecorder();
  const { button } = screen;
  await userEvent.click(button());
  await act(async () => button().blur());
  await act(async () => pending.resolve());
  await screen.expectRecording(false);
  expect(suppress).toHaveBeenLastCalledWith(false);
  expect(recorded).not.toHaveBeenCalled();
});

it("reports suppression failures instead of arming the recorder", async () => {
  setup();
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  suppress.mockRejectedValue(new Error("Couldn't pause capture"));
  await using screen = await renderRecorder();
  const { button } = screen;
  await userEvent.click(button());
  await screen.expectRecording(false);
  expect(error).toHaveBeenCalledWith("Couldn't pause capture");
});

it("does not record Tab, unmodified keys, or modifier keys on their own", async () => {
  setup();
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  await using screen = await renderRecorder();
  const { button } = screen;
  await screen.start();
  await press("y");
  await press("{Control>}{/Control}");
  expect(recorded).not.toHaveBeenCalled();
  await screen.expectRecording(true);
  await press("{Tab}");
  expect(document.activeElement).not.toBe(button());
});

it("rejects modifier pairs on Wayland but accepts the next key chord", async () => {
  setup();
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  await using screen = await renderRecorder();

  await screen.start();
  await press("{ShiftLeft>}{ShiftRight>}{/ShiftRight}{/ShiftLeft}");
  expect(recorded).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(expect.stringContaining("Add a letter, number"));
  await screen.expectRecording(true);
  await press("{Control>}{Alt>}y{/Alt}{/Control}");
  expect(recorded).toHaveBeenCalledOnce();
});

it("preserves native modifier-pair recording and tracks released keys", async () => {
  setup();
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  await using screen = await renderRecorder({ allowModifierPairs: true });

  await screen.start();
  await press("{ShiftLeft}");
  await press("{ShiftRight>}");
  expect(recorded).not.toHaveBeenCalled();
  await press("{ShiftLeft>}");
  expect(recorded).toHaveBeenCalledExactlyOnceWith({ kind: "both-shift-keys" });
  await press("{/ShiftLeft}{/ShiftRight}");
});
