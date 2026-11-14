import { assert, describe, it } from "vite-plus/test";

import {
  openSwitcher,
  switcherKeyEvent,
  tapTarget,
  updateSwitcher,
  type SwitcherOpen,
} from "./recentThreadSwitcher.logic";

const keys = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
const cold = { backwards: false, covered: false, ownCount: 0 };

function opened(order: readonly string[], options = cold): SwitcherOpen {
  const { state } = openSwitcher(order, options);
  assert.isNotNull(state);
  return state!;
}

describe("openSwitcher", () => {
  it("taps to the previous thread, or to the covered one", () => {
    assert.strictEqual(tapTarget(keys(4), cold), "t1");
    assert.strictEqual(tapTarget(keys(3), { ...cold, backwards: true, covered: true }), "t0");
    assert.strictEqual(tapTarget(["a"], { ...cold, covered: true }), "a");
    assert.isNull(tapTarget(["a"], cold));
    assert.isNull(tapTarget([], cold));
  });

  it("goes back to the oldest of this window's visits, else to the last row", () => {
    assert.equal(opened(keys(10), { ...cold, backwards: true, ownCount: 3 }).highlight, 2);
    assert.equal(opened(keys(10), { ...cold, backwards: true, ownCount: 1 }).highlight, 9);
  });
});

describe("updateSwitcher", () => {
  it("tabs both ways with wrapping and shows the list", () => {
    const state = opened(keys(3));
    const next = updateSwitcher(state, { type: "tab", backwards: false }).state!;
    assert.equal(next.highlight, 2);
    assert.isTrue(next.shown);
    assert.equal(updateSwitcher(next, { type: "tab", backwards: false }).state!.highlight, 0);
    const first = updateSwitcher(state, { type: "tab", backwards: true }).state!;
    assert.equal(updateSwitcher(first, { type: "tab", backwards: true }).state!.highlight, 2);
  });

  it("choosing the current thread closes without switching", () => {
    assert.deepEqual(updateSwitcher(opened(keys(3)), { type: "choose", index: 0 }), {
      state: null,
      switchTo: null,
    });
  });
});

describe("switcherKeyEvent", () => {
  const press = (key: string, extra: { ctrlKey?: boolean; shiftKey?: boolean } = {}) => ({
    key,
    code: key,
    ctrlKey: true,
    shiftKey: false,
    ...extra,
  });

  const next = (code: string) => ({ code, backwards: false });
  const previous = (code: string) => ({ code, backwards: true });

  it.each([
    [press("Tab"), next("Tab"), { type: "tab", backwards: false }],
    [press("Tab", { shiftKey: true }), previous("Tab"), { type: "tab", backwards: true }],
    [press("Tab", { shiftKey: true }), next("KeyJ"), { type: "tab", backwards: true }],
    [press("KeyJ"), previous("KeyJ"), { type: "tab", backwards: true }],
    [press("Enter"), next("Enter"), { type: "tab", backwards: false }],
    [press("Enter"), next("Tab"), { type: "commit" }],
    [press("Tab", { ctrlKey: false }), next("Tab"), { type: "commit" }],
    [press("Escape"), next("Tab"), { type: "cancel" }],
    [press("s"), next("Tab"), null],
  ] as const)("%o opened by %o is %o", (event, opener, expected) => {
    assert.deepEqual(switcherKeyEvent(event, opener), expected);
  });
});
