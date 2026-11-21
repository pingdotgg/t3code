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

it.each([true, false])(
  "records Option symbols and refreshes the current layout (keyboard events: %s)",
  async (supportsEvents) => {
    let layout = Promise.resolve(new Map([["KeyQ", "a"]]));
    const keyboard = Object.assign(supportsEvents ? new EventTarget() : {}, {
      getLayoutMap: () => layout,
    });
    const focusTarget = new EventTarget();
    stop = trackKeyboardLayout(keyboard, focusTarget);
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
    const pending = pendingLayout();
    layout = pending.promise;
    focusTarget.dispatchEvent(new Event("focus"));
    assert.strictEqual(keybindingFromKeyboardEvent(event, "MacIntel"), "mod+alt+shift+a");
    pending.resolve(new Map([["KeyQ", "q"]]));
    await layout;
    assert.strictEqual(keybindingFromKeyboardEvent(event, "MacIntel"), "mod+alt+shift+q");
    layout = Promise.reject(new Error("Permission denied"));
    focusTarget.dispatchEvent(new Event("focus"));
    assert.strictEqual(getKeyboardLayoutMap()?.get("KeyQ"), "q");
    await layout.catch(() => undefined);
    assert.strictEqual(getKeyboardLayoutMap(), undefined);
    layout = Promise.resolve(new Map([["KeyQ", "a"]]));
    stop();
    focusTarget.dispatchEvent(new Event("focus"));
    await keyboard.getLayoutMap();
    assert.strictEqual(getKeyboardLayoutMap(), undefined);
  },
);

it("ignores an obsolete layout result and clears the map when access fails", async () => {
  const pending = pendingLayout();
  let result = pending.promise;
  const keyboard = Object.assign(new EventTarget(), { getLayoutMap: () => result });
  stop = trackKeyboardLayout(keyboard);
  result = Promise.resolve(new Map([["KeyQ", "q"]]));
  keyboard.dispatchEvent(new Event("layoutchange"));
  assert.strictEqual(getKeyboardLayoutMap(), undefined);
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
