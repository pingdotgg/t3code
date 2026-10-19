import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

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
let root: Root;
let container: HTMLDivElement;
let recording = false;

function Recorder(props: { allowModifierPairs?: boolean; shortcutLabel?: string }) {
  const recorder = useSnapShotShortcutRecorder({
    shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
    shortcutLabel: props.shortcutLabel,
    allowModifierPairs: props.allowModifierPairs ?? false,
    onRecord: recorded,
    onError: error,
  });
  useEffect(() => {
    recording = recorder.recording;
  });
  return recorder.input;
}

async function render(props: Parameters<typeof Recorder>[0] = {}) {
  await act(async () => root.render(<Recorder {...props} />));
}
const button = () => container.querySelector<HTMLButtonElement>("[data-keybinding-capture]")!;
async function start(props: Parameters<typeof Recorder>[0] = {}) {
  await render(props);
  await act(async () => userEvent.click(button()));
  expect(recording).toBe(true);
}
const press = (keys: string) => act(async () => userEvent.keyboard(keys));
function setPlatform(platform: string) {
  Object.defineProperty(navigator, "platform", { configurable: true, get: () => platform });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  suppress.mockReset().mockResolvedValue(undefined);
  recorded.mockReset();
  error.mockReset();
  setPlatform("Linux x86_64");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(navigator, "platform");
  vi.unstubAllGlobals();
});

it("suppresses capture while recording and uses the physical key for shifted digits", async () => {
  await start();
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
  expect(recording).toBe(false);
});

it("lets users replace an unrecognized desktop label without displaying guessed keys", async () => {
  const shortcutLabel = "Use the shortcut assigned in desktop settings";
  await render({ shortcutLabel });
  expect(button().textContent).toBe("Change shortcut");
  expect(button().getAttribute("aria-label")).toBe("Change snapshot shortcut");
  await act(async () => userEvent.click(button()));
  expect(button().textContent).toBe("Press shortcut…");
  await press("{Control>}{Shift>}2{/Shift}{/Control}");
  expect(recorded).toHaveBeenCalledWith(
    expect.objectContaining({ key: "2", modKey: true, shiftKey: true }),
  );
  expect(suppress).toHaveBeenLastCalledWith(false);
});

it("records macOS Command without treating it as Control", async () => {
  setPlatform("MacIntel");
  await start({ allowModifierPairs: true });
  await press("{Meta>}k{/Meta}");
  expect(recorded).toHaveBeenCalledWith(expect.objectContaining({ key: "k", modKey: true }));
});

it.each(["Escape", "blur", "unmount"])("cancels on %s without selecting keys", async (cancel) => {
  await start();
  if (cancel === "Escape") {
    const outside = vi.fn();
    document.addEventListener("keydown", outside);
    await press("{Escape}");
    document.removeEventListener("keydown", outside);
    expect(outside).not.toHaveBeenCalled();
  } else if (cancel === "blur") await act(async () => button().blur());
  else await act(async () => root.render(null));
  expect(suppress).toHaveBeenLastCalledWith(false);
  expect(recorded).not.toHaveBeenCalled();
  if (cancel !== "unmount") expect(recording).toBe(false);
});

it("ignores late suppression acknowledgements after cancellation", async () => {
  const pending = deferred<void>();
  suppress.mockImplementation((enabled) => (enabled ? pending.promise : Promise.resolve()));
  await render();
  await act(async () => userEvent.click(button()));
  await act(async () => button().blur());
  await act(async () => pending.resolve());
  expect(recording).toBe(false);
  expect(suppress).toHaveBeenLastCalledWith(false);
  expect(recorded).not.toHaveBeenCalled();
});

it("reports suppression failures instead of arming the recorder", async () => {
  suppress.mockRejectedValue(new Error("Couldn't pause capture"));
  await render();
  await act(async () => userEvent.click(button()));
  expect(recording).toBe(false);
  expect(error).toHaveBeenCalledWith("Couldn't pause capture");
});

it("does not record Tab, unmodified keys, or modifier keys on their own", async () => {
  await start();
  await press("y");
  await press("{Control>}{/Control}");
  expect(recorded).not.toHaveBeenCalled();
  expect(recording).toBe(true);
  await press("{Tab}");
  expect(document.activeElement).not.toBe(button());
});

it("rejects modifier pairs on Wayland but accepts the next key chord", async () => {
  await start();
  await press("{ShiftLeft>}{ShiftRight>}{/ShiftRight}{/ShiftLeft}");
  expect(recorded).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(expect.stringContaining("Add a letter, number"));
  expect(recording).toBe(true);
  await press("{Control>}{Alt>}y{/Alt}{/Control}");
  expect(recorded).toHaveBeenCalledOnce();
});

it("preserves native modifier-pair recording and tracks released keys", async () => {
  await start({ allowModifierPairs: true });
  await press("{ShiftLeft}");
  await press("{ShiftRight>}");
  expect(recorded).not.toHaveBeenCalled();
  await press("{ShiftLeft>}");
  expect(recorded).toHaveBeenCalledExactlyOnceWith({ kind: "both-shift-keys" });
  await press("{/ShiftLeft}{/ShiftRight}");
});
