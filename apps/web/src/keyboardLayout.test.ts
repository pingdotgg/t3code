import { afterEach, assert, it } from "vite-plus/test";
import { getKeyboardLayoutMap, trackKeyboardLayout } from "./keyboardLayout";
import { keybindingFromKeyboardEvent } from "./components/settings/KeybindingsSettings.logic";

let stop: (() => void) | undefined;
afterEach(() => stop?.());

function pendingLayout() {
  let resolve!: (layout: Map<string, string>) => void;
  const promise = new Promise<Map<string, string>>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("records Option symbols using the current layout and updates after a layout change", async () => {
  let layout = new Map([["KeyQ", "a"]]);
  const keyboard = Object.assign(new EventTarget(), {
    getLayoutMap: () => Promise.resolve(layout),
  });
  stop = trackKeyboardLayout(keyboard);
  await keyboard.getLayoutMap();
  const event = {
    key: "Æ",
    code: "KeyQ",
    metaKey: true,
    ctrlKey: false,
    altKey: true,
    shiftKey: true,
  };
  assert.strictEqual(keybindingFromKeyboardEvent(event, "MacIntel"), "mod+alt+shift+a");
  assert.strictEqual(
    keybindingFromKeyboardEvent(event, "MacIntel", { layoutCharacter: true }),
    "mod+alt+shift+a",
  );
  layout = new Map([["KeyQ", "q"]]);
  keyboard.dispatchEvent(new Event("layoutchange"));
  await keyboard.getLayoutMap();
  assert.strictEqual(keybindingFromKeyboardEvent(event, "MacIntel"), "mod+alt+shift+q");
  stop();
  assert.strictEqual(getKeyboardLayoutMap(), undefined);
});

it("ignores an obsolete layout result and clears the map when access fails", async () => {
  const pending = pendingLayout();
  let result = pending.promise;
  const keyboard = Object.assign(new EventTarget(), { getLayoutMap: () => result });
  stop = trackKeyboardLayout(keyboard);
  result = Promise.resolve(new Map([["KeyQ", "q"]]));
  keyboard.dispatchEvent(new Event("layoutchange"));
  await result;
  pending.resolve(new Map([["KeyQ", "a"]]));
  await pending.promise;
  assert.strictEqual(getKeyboardLayoutMap()?.get("KeyQ"), "q");
  result = Promise.reject(new Error("Permission denied"));
  keyboard.dispatchEvent(new Event("layoutchange"));
  await result.catch(() => undefined);
  assert.strictEqual(getKeyboardLayoutMap(), undefined);
});

it("does not publish a pending result after disposal", async () => {
  const pending = pendingLayout();
  const keyboard = Object.assign(new EventTarget(), { getLayoutMap: () => pending.promise });
  stop = trackKeyboardLayout(keyboard);
  stop();
  pending.resolve(new Map([["KeyQ", "a"]]));
  await pending.promise;
  assert.strictEqual(getKeyboardLayoutMap(), undefined);
});
