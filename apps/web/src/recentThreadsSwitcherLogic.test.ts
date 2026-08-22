import { describe, expect, it } from "vite-plus/test";

import {
  type RecentThreadsSwitcherSession,
  reconcileRecentThreadsSwitcherSession,
  shouldCommitRecentThreadsSwitcherOnKeyUp,
} from "./recentThreadsSwitcherLogic";

const session = (overrides: Partial<RecentThreadsSwitcherSession> = {}) => ({
  entries: ["env:a", "env:b", "env:c"],
  selectedIndex: 1,
  holdsCtrl: true,
  holdsMeta: false,
  holdsAlt: false,
  holdsShift: false,
  triggerKey: "Tab",
  ...overrides,
});

const keyUp = (key: string, heldModifiers: ReadonlyArray<string> = []) => ({
  code: key,
  key,
  getModifierState: (modifier: string) => heldModifiers.includes(modifier),
});

describe("recent-thread switcher session", () => {
  it("keeps the selected thread while filtering entries that are no longer live", () => {
    expect(
      reconcileRecentThreadsSwitcherSession(session(), (threadKey) => threadKey !== "env:a"),
    ).toMatchObject({
      entries: ["env:b", "env:c"],
      selectedIndex: 0,
    });
  });

  it("selects the nearest remaining thread when the selected entry disappears", () => {
    expect(
      reconcileRecentThreadsSwitcherSession(session(), (threadKey) => threadKey !== "env:b"),
    ).toMatchObject({
      entries: ["env:a", "env:c"],
      selectedIndex: 1,
    });
  });

  it("cancels when no recent entries remain live", () => {
    expect(reconcileRecentThreadsSwitcherSession(session(), () => false)).toBeNull();
  });

  it("commits a held-modifier binding only after every opening modifier is released", () => {
    expect(shouldCommitRecentThreadsSwitcherOnKeyUp(session(), keyUp("Tab", ["Control"]))).toBe(
      false,
    );
    expect(shouldCommitRecentThreadsSwitcherOnKeyUp(session(), keyUp("ControlLeft"))).toBe(true);
  });

  it("supports Shift-only and modifier-free bindings", () => {
    const shiftOnly = session({ holdsCtrl: false, holdsShift: true, triggerKey: "F6" });
    expect(shouldCommitRecentThreadsSwitcherOnKeyUp(shiftOnly, keyUp("F6", ["Shift"]))).toBe(false);
    expect(shouldCommitRecentThreadsSwitcherOnKeyUp(shiftOnly, keyUp("ShiftLeft"))).toBe(true);

    const modifierFree = session({ holdsCtrl: false, triggerKey: "F6" });
    expect(shouldCommitRecentThreadsSwitcherOnKeyUp(modifierFree, keyUp("F5"))).toBe(false);
    expect(shouldCommitRecentThreadsSwitcherOnKeyUp(modifierFree, keyUp("F6"))).toBe(true);
  });
});
