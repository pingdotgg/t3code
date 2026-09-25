import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { useSnapShotShortcutRecorder } from "./useSnapShotShortcutRecorder";

const effects = vi.hoisted(() => [] as (() => () => void)[]);
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
    useEffect: (effect: () => () => void) => effects.push(effect),
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
const suppress = vi.hoisted(() => vi.fn<(_: boolean) => Promise<void>>());
vi.mock("../../lib/desktopSnapShot", () => ({
  getDesktopSnapShotBridge: () => ({ setSnapShotShortcutSuppressed: suppress }),
}));

const recorded = vi.fn();
const error = vi.fn();
function render(allowModifierPairs = false, shortcutLabel?: string) {
  hooks.beginRender();
  return useSnapShotShortcutRecorder({
    shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
    shortcutLabel,
    allowModifierPairs,
    onRecord: recorded,
    onError: error,
  });
}
function event(key: string, code = key, extra: object = {}) {
  return {
    key,
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    repeat: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...extra,
  };
}
async function start(allowModifierPairs = false) {
  render(allowModifierPairs).input.props.onClick();
  await suppress.mock.results.at(-1)!.value;
  return render(allowModifierPairs);
}
beforeEach(() => {
  hooks.reset();
  effects.length = 0;
  suppress.mockReset().mockResolvedValue(undefined);
  recorded.mockReset();
  error.mockReset();
  vi.stubGlobal("navigator", { platform: "Linux" });
});
afterEach(() => vi.unstubAllGlobals());

it("suppresses capture while recording and uses the physical key for shifted digits", async () => {
  const recorder = await start();
  expect(recorder.recording).toBe(true);
  expect(suppress).toHaveBeenCalledExactlyOnceWith(true);
  recorder.input.props.onKeyDown(event("@", "Digit2", { ctrlKey: true, shiftKey: true }));
  expect(recorded).toHaveBeenCalledExactlyOnceWith({
    key: "2",
    modKey: true,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: true,
  });
  expect(suppress).toHaveBeenLastCalledWith(false);
  expect(render().recording).toBe(false);
});
it("lets users replace an unrecognized desktop label without displaying guessed keys", async () => {
  const label = "Use the shortcut assigned in desktop settings";
  let recorder = render(false, label);
  expect(recorder.input.props.children).toBe("Change shortcut");
  expect(recorder.input.props["aria-label"]).toBe("Change snapshot shortcut");
  recorder.input.props.onClick();
  await suppress.mock.results.at(-1)!.value;
  recorder = render(false, label);
  expect(recorder.input.props.children).toBe("Press shortcut…");
  recorder.input.props.onKeyDown(event("@", "Digit2", { ctrlKey: true, shiftKey: true }));
  expect(recorded).toHaveBeenCalledWith(
    expect.objectContaining({ key: "2", modKey: true, shiftKey: true }),
  );
  expect(suppress).toHaveBeenLastCalledWith(false);
});
it("records macOS Command without treating it as Control", async () => {
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  (await start(true)).input.props.onKeyDown(event("k", "KeyK", { metaKey: true }));
  expect(recorded).toHaveBeenCalledWith(expect.objectContaining({ key: "k", modKey: true }));
});
it.each(["Escape", "blur", "unmount"])("cancels on %s without selecting keys", async (cancel) => {
  const recorder = await start();
  if (cancel === "Escape") {
    const escape = event("Escape");
    recorder.input.props.onKeyDown(escape);
    expect(escape.preventDefault).toHaveBeenCalled();
    expect(escape.stopPropagation).toHaveBeenCalled();
  } else if (cancel === "blur") recorder.input.props.onBlur();
  else effects[0]!()();
  expect(suppress).toHaveBeenLastCalledWith(false);
  expect(recorded).not.toHaveBeenCalled();
  if (cancel !== "unmount") expect(render().recording).toBe(false);
});
it("ignores late suppression acknowledgements after cancellation", async () => {
  let resolve!: () => void;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  suppress.mockImplementation((enabled) => (enabled ? pending : Promise.resolve()));
  render().input.props.onClick();
  render().input.props.onBlur();
  resolve();
  await pending;
  expect(render().recording).toBe(false);
  expect(suppress).toHaveBeenLastCalledWith(false);
  expect(recorded).not.toHaveBeenCalled();
});
it("reports suppression failures instead of arming the recorder", async () => {
  suppress.mockRejectedValue(new Error("Couldn't pause capture"));
  render().input.props.onClick();
  await suppress.mock.results[0]!.value.catch(() => undefined);
  expect(render().recording).toBe(false);
  expect(error).toHaveBeenCalledWith("Couldn't pause capture");
});
it("does not record Tab, held repeats, or modifier keys on their own", async () => {
  const recorder = await start();
  const tab = event("Tab");
  recorder.input.props.onKeyDown(tab);
  recorder.input.props.onKeyDown(event("y", "KeyY", { ctrlKey: true, repeat: true }));
  recorder.input.props.onKeyDown(event("Control", "ControlLeft", { ctrlKey: true }));
  expect(tab.preventDefault).not.toHaveBeenCalled();
  expect(recorded).not.toHaveBeenCalled();
  expect(render().recording).toBe(true);
});
it("rejects modifier pairs on Wayland but accepts the next key chord", async () => {
  const recorder = await start();
  recorder.input.props.onKeyDown(event("Shift", "ShiftLeft", { shiftKey: true }));
  recorder.input.props.onKeyDown(event("Shift", "ShiftRight", { shiftKey: true }));
  expect(recorded).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(expect.stringContaining("Add a letter, number"));
  expect(render().recording).toBe(true);
  render().input.props.onKeyDown(event("y", "KeyY", { ctrlKey: true, altKey: true }));
  expect(recorded).toHaveBeenCalledOnce();
});
it("preserves native modifier-pair recording and tracks released keys", async () => {
  const recorder = await start(true);
  recorder.input.props.onKeyDown(event("Shift", "ShiftLeft", { shiftKey: true }));
  recorder.input.props.onKeyUp(event("Shift", "ShiftLeft"));
  recorder.input.props.onKeyDown(event("Shift", "ShiftRight", { shiftKey: true }));
  expect(recorded).not.toHaveBeenCalled();
  recorder.input.props.onKeyDown(event("Shift", "ShiftLeft", { shiftKey: true }));
  expect(recorded).toHaveBeenCalledExactlyOnceWith({ kind: "both-shift-keys" });
});
