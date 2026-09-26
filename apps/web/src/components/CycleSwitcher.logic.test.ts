import { assert, describe, it } from "vite-plus/test";

import {
  CYCLE_SWITCHER_MODE,
  commitModifiersForShortcutEvent,
  cycleSwitcherCommandInfo,
  cycleSwitcherCommitModifiersReleased,
  resolveCycleSwitcherIndex,
} from "./CycleSwitcher.logic";

describe("cycleSwitcherCommandInfo", () => {
  it("maps project commands to project mode", () => {
    assert.deepEqual(cycleSwitcherCommandInfo("project.switcher"), {
      mode: CYCLE_SWITCHER_MODE.project,
      direction: 1,
    });
    assert.deepEqual(cycleSwitcherCommandInfo("project.switcherPrevious"), {
      mode: CYCLE_SWITCHER_MODE.project,
      direction: -1,
    });
  });

  it("maps thread commands to thread mode", () => {
    assert.deepEqual(cycleSwitcherCommandInfo("thread.switcher"), {
      mode: CYCLE_SWITCHER_MODE.thread,
      direction: 1,
    });
    assert.deepEqual(cycleSwitcherCommandInfo("thread.switcherPrevious"), {
      mode: CYCLE_SWITCHER_MODE.thread,
      direction: -1,
    });
  });

  it("ignores unrelated commands", () => {
    assert.equal(cycleSwitcherCommandInfo("thread.next"), null);
    assert.equal(cycleSwitcherCommandInfo(null), null);
  });
});

describe("resolveCycleSwitcherIndex", () => {
  it("wraps forward and backward past the ends", () => {
    assert.equal(
      resolveCycleSwitcherIndex({
        stepOffset: 1,
        length: 3,
        currentIndex: 0,
        initialDirection: 1,
      }),
      1,
    );
    assert.equal(
      resolveCycleSwitcherIndex({
        stepOffset: 3,
        length: 3,
        currentIndex: 0,
        initialDirection: 1,
      }),
      0,
    );
    assert.equal(
      resolveCycleSwitcherIndex({
        stepOffset: -1,
        length: 3,
        currentIndex: 0,
        initialDirection: -1,
      }),
      2,
    );
  });

  it("returns to the start when direction is reversed", () => {
    assert.equal(
      resolveCycleSwitcherIndex({
        stepOffset: 0,
        length: 4,
        currentIndex: 0,
        initialDirection: 1,
      }),
      0,
    );
  });

  it("does not skip the first item when there is no current entry", () => {
    assert.equal(
      resolveCycleSwitcherIndex({
        stepOffset: 1,
        length: 4,
        currentIndex: -1,
        initialDirection: 1,
      }),
      0,
    );
    assert.equal(
      resolveCycleSwitcherIndex({
        stepOffset: -1,
        length: 4,
        currentIndex: -1,
        initialDirection: -1,
      }),
      3,
    );
  });

  it("stays at zero when there are no entries", () => {
    assert.equal(
      resolveCycleSwitcherIndex({
        stepOffset: 2,
        length: 0,
        currentIndex: -1,
        initialDirection: 1,
      }),
      0,
    );
  });
});

describe("commitModifiersForShortcutEvent", () => {
  it("collects the primary modifiers being held", () => {
    assert.deepEqual(
      commitModifiersForShortcutEvent({
        metaKey: false,
        ctrlKey: false,
        altKey: true,
        shiftKey: false,
      }),
      ["altKey"],
    );
    assert.deepEqual(
      commitModifiersForShortcutEvent({
        metaKey: true,
        ctrlKey: false,
        altKey: true,
        shiftKey: false,
      }),
      ["metaKey", "altKey"],
    );
  });

  it("ignores shift, which only selects direction", () => {
    assert.deepEqual(
      commitModifiersForShortcutEvent({
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
      }),
      [],
    );
  });

  it("returns nothing for an unmodified press", () => {
    assert.deepEqual(
      commitModifiersForShortcutEvent({
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
      [],
    );
  });
});

describe("cycleSwitcherCommitModifiersReleased", () => {
  it("waits while any commit modifier is held", () => {
    assert.isFalse(
      cycleSwitcherCommitModifiersReleased(
        { metaKey: false, ctrlKey: false, altKey: true, shiftKey: false },
        ["altKey"],
      ),
    );
  });

  it("commits once every commit modifier is released", () => {
    assert.isTrue(
      cycleSwitcherCommitModifiersReleased(
        { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false },
        ["altKey"],
      ),
    );
  });

  it("never commits without a tracked modifier", () => {
    assert.isFalse(
      cycleSwitcherCommitModifiersReleased(
        { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false },
        [],
      ),
    );
  });
});
