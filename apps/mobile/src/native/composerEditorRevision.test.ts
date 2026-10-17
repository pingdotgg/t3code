import { describe, expect, it } from "@effect/vitest";

import {
  acknowledgeComposerNativeEvent,
  assumeComposerControlledState,
  isComposerNativeEcho,
  pruneAcknowledgedComposerNativeEvents,
  reconcileComposerSubmitSnapshot,
  resolveComposerControlledEventCount,
} from "./composerEditorRevision";

describe("acknowledgeComposerNativeEvent", () => {
  it("advances to newer native text revisions", () => {
    expect(acknowledgeComposerNativeEvent(4, 5)).toBe(5);
  });

  it("accepts a duplicate event from the current native revision", () => {
    expect(acknowledgeComposerNativeEvent(5, 5)).toBe(5);
  });

  it("rejects events older than the latest native text revision", () => {
    expect(acknowledgeComposerNativeEvent(5, 4)).toBeNull();
  });

  it("rejects malformed revision counters", () => {
    expect(acknowledgeComposerNativeEvent(5, Number.NaN)).toBeNull();
    expect(acknowledgeComposerNativeEvent(5, 5.5)).toBeNull();
  });
});

describe("isComposerNativeEcho", () => {
  const snapshots = [{ eventCount: 3, value: "native", selection: { start: 6, end: 6 } }];

  it("matches the exact native text revision and selection", () => {
    expect(isComposerNativeEcho("native", { start: 6, end: 6 }, 3, snapshots)).toBe(true);
  });

  it("does not claim parent-driven selection or repeated-text updates", () => {
    expect(isComposerNativeEcho("native", { start: 2, end: 2 }, 3, snapshots)).toBe(false);
    expect(isComposerNativeEcho("native", { start: 6, end: 6 }, 4, snapshots)).toBe(false);
    expect(isComposerNativeEcho("parent edit", { start: 6, end: 6 }, 3, snapshots)).toBe(false);
  });

  it("matches value and revision when selection is uncontrolled", () => {
    expect(isComposerNativeEcho("native", null, 3, snapshots)).toBe(true);
  });

  it("does not claim a controlled selection against an assumed state without one", () => {
    const assumed = [{ eventCount: 3, value: "native", selection: null }];
    expect(isComposerNativeEcho("native", { start: 0, end: 0 }, 3, assumed)).toBe(false);
    expect(isComposerNativeEcho("other", { start: 0, end: 0 }, 3, assumed)).toBe(false);
  });

  it("matches an assumed state when selection is uncontrolled", () => {
    const assumed = [{ eventCount: 3, value: "native", selection: null }];
    expect(isComposerNativeEcho("native", null, 3, assumed)).toBe(true);
  });
});

describe("resolveComposerControlledEventCount", () => {
  const snapshots = [
    { eventCount: 0, value: "", selection: { start: 0, end: 0 } },
    { eventCount: 2, value: "a", selection: { start: 1, end: 1 } },
    { eventCount: 4, value: "ab", selection: { start: 2, end: 2 } },
  ];

  it("tags a delayed parent value with the native revision that produced it", () => {
    expect(resolveComposerControlledEventCount("a", { start: 1, end: 1 }, 4, snapshots)).toBe(2);
  });

  it("does not acknowledge the pre-edit parent value as the latest revision", () => {
    expect(resolveComposerControlledEventCount("", { start: 0, end: 0 }, 4, snapshots)).toBe(0);
  });

  it("acknowledges the latest native value at the latest revision", () => {
    expect(resolveComposerControlledEventCount("ab", { start: 2, end: 2 }, 4, snapshots)).toBe(4);
  });

  it("allows an unmatched parent-driven edit at the latest native revision", () => {
    expect(resolveComposerControlledEventCount("/plan ", { start: 6, end: 6 }, 4, snapshots)).toBe(
      4,
    );
  });

  it("uses the newest revision when selection events repeat the same value", () => {
    expect(
      resolveComposerControlledEventCount("ab", { start: 1, end: 1 }, 5, [
        ...snapshots,
        { eventCount: 5, value: "ab", selection: { start: 1, end: 1 } },
      ]),
    ).toBe(5);
  });

  it("keeps a stale selection paired with current text behind the native revision", () => {
    expect(resolveComposerControlledEventCount("ab", { start: 1, end: 1 }, 4, snapshots)).toBe(3);
  });

  it("does not control selection when no selection prop is provided", () => {
    expect(resolveComposerControlledEventCount("ab", null, 4, snapshots)).toBe(4);
  });
});

describe("pruneAcknowledgedComposerNativeEvents", () => {
  it("releases an arbitrarily long acknowledged backlog without a fixed-size cliff", () => {
    const snapshots = Array.from({ length: 1_000 }, (_, eventCount) => ({
      eventCount,
      value: `value-${eventCount}`,
      selection: { start: eventCount, end: eventCount },
    }));

    expect(pruneAcknowledgedComposerNativeEvents(snapshots, 999)).toEqual([snapshots[999]]);
  });

  it("retains native events that arrive after the acknowledged render", () => {
    const snapshots = [
      { eventCount: 40, value: "a", selection: { start: 1, end: 1 } },
      { eventCount: 41, value: "ab", selection: { start: 2, end: 2 } },
    ];

    expect(pruneAcknowledgedComposerNativeEvents(snapshots, 40)).toEqual(snapshots);
  });

  it("retains the newest acknowledged snapshot so settled re-renders stay echoes", () => {
    const snapshots = [
      { eventCount: 40, value: "a", selection: { start: 1, end: 1 } },
      { eventCount: 41, value: "ab", selection: { start: 2, end: 2 } },
      { eventCount: 42, value: "abc", selection: { start: 3, end: 3 } },
    ];

    const pruned = pruneAcknowledgedComposerNativeEvents(snapshots, 42);
    expect(pruned).toEqual([snapshots[2]]);
    expect(isComposerNativeEcho("abc", { start: 3, end: 3 }, 42, pruned)).toBe(true);
  });

  it("keeps the newest of several snapshots sharing the acknowledged revision", () => {
    const snapshots = [
      { eventCount: 41, value: "ab", selection: { start: 2, end: 2 } },
      { eventCount: 41, value: "ab", selection: { start: 1, end: 1 } },
    ];

    expect(pruneAcknowledgedComposerNativeEvents(snapshots, 41)).toEqual([snapshots[1]]);
  });
});

describe("assumeComposerControlledState", () => {
  it("replaces the acknowledged history with the applied controlled state", () => {
    const snapshots = [{ eventCount: 3, value: "typed", selection: { start: 5, end: 5 } }];

    expect(assumeComposerControlledState(snapshots, 3, "")).toEqual([
      { eventCount: 3, value: "", selection: null },
    ]);
  });

  it("keeps native events that raced past the controlled revision", () => {
    const snapshots = [
      { eventCount: 3, value: "typed", selection: { start: 5, end: 5 } },
      { eventCount: 4, value: "typed!", selection: { start: 6, end: 6 } },
    ];

    expect(assumeComposerControlledState(snapshots, 3, "")).toEqual([
      { eventCount: 3, value: "", selection: null },
      snapshots[1],
    ]);
  });

  it("applies a parent caret move on the assumed value at the assumed revision", () => {
    const snapshots = assumeComposerControlledState([], 3, "typed");

    expect(isComposerNativeEcho("typed", { start: 2, end: 2 }, 3, snapshots)).toBe(false);
    expect(resolveComposerControlledEventCount("typed", { start: 2, end: 2 }, 3, snapshots)).toBe(
      3,
    );
  });

  it("re-applies a parent value that round-trips back to an acknowledged state", () => {
    const snapshots = assumeComposerControlledState(
      [{ eventCount: 3, value: "typed", selection: { start: 5, end: 5 } }],
      3,
      "",
    );

    expect(isComposerNativeEcho("typed", { start: 5, end: 5 }, 3, snapshots)).toBe(false);
    expect(resolveComposerControlledEventCount("typed", { start: 5, end: 5 }, 3, snapshots)).toBe(
      3,
    );
  });
});

describe("typing immediately before an intercepted paste", () => {
  it("keeps the pre-paste React value behind the native paste revision", () => {
    const snapshots = [
      { eventCount: 0, value: "", selection: { start: 0, end: 0 } },
      { eventCount: 1, value: "typed", selection: { start: 5, end: 5 } },
      { eventCount: 2, value: "typed", selection: { start: 0, end: 5 } },
    ];
    expect(resolveComposerControlledEventCount("typed", { start: 5, end: 5 }, 2, snapshots)).toBe(
      1,
    );
    expect(isComposerNativeEcho("typed", { start: 0, end: 5 }, 2, snapshots)).toBe(true);
    expect(resolveComposerControlledEventCount("pasted", { start: 6, end: 6 }, 2, snapshots)).toBe(
      2,
    );
    expect(isComposerNativeEcho("pasted", { start: 6, end: 6 }, 2, snapshots)).toBe(false);
    expect(acknowledgeComposerNativeEvent(2, 1)).toBeNull();
  });
});

describe("committed submission snapshot", () => {
  it("allows clearing the corrected draft while rejecting delayed pre-submit events", () => {
    const correction = { eventCount: 8, value: "The", selection: { start: 3, end: 3 } };
    // Native advances once more after resignFirstResponder commits the correction.
    const submitted = { ...correction, eventCount: 9 };
    const eventCount = acknowledgeComposerNativeEvent(7, submitted.eventCount)!;
    const snapshots = [
      { eventCount: 7, value: "Teh", selection: { start: 3, end: 3 } },
      correction,
      submitted,
    ];

    expect(resolveComposerControlledEventCount("", null, eventCount, snapshots)).toBe(9);
    expect(isComposerNativeEcho("", null, eventCount, snapshots)).toBe(false);
    expect(acknowledgeComposerNativeEvent(eventCount, correction.eventCount)).toBeNull();
    expect(acknowledgeComposerNativeEvent(eventCount, 7)).toBeNull();
    expect(acknowledgeComposerNativeEvent(eventCount, 10)).toBe(10);
  });
});

describe("cancelled submit preparation", () => {
  it.each(["", "previous draft", "corrected edit"])(
    "allows replacement content %j after discarding a prepared snapshot",
    (replacement) => {
      const history = [
        { eventCount: 7, value: replacement, selection: { start: 0, end: 0 } },
        { eventCount: 8, value: "queued edit", selection: { start: 11, end: 11 } },
      ];
      const prepared = {
        eventCount: 9,
        value: "corrected edit",
        selection: { start: 14, end: 14 },
      };
      const recovered = reconcileComposerSubmitSnapshot(8, history, prepared, false);
      // A cancelled response still has to advance JS past the revision that
      // native created. Otherwise native rejects the replacement document.
      expect(recovered).not.toBeNull();
      if (!recovered) return;
      const controlledCount = resolveComposerControlledEventCount(
        replacement,
        null,
        recovered.eventCount,
        recovered.snapshots,
      );
      expect(controlledCount).toBeGreaterThanOrEqual(prepared.eventCount);
      expect(isComposerNativeEcho(replacement, null, controlledCount, recovered.snapshots)).toBe(
        false,
      );
      expect(acknowledgeComposerNativeEvent(recovered.eventCount, 8)).toBeNull();
      expect(acknowledgeComposerNativeEvent(recovered.eventCount, 10)).toBe(10);
    },
  );

  it("does not roll back newer native edits when a cancelled response arrives late", () => {
    expect(
      reconcileComposerSubmitSnapshot(
        10,
        [],
        {
          eventCount: 9,
          value: "discarded",
          selection: null,
        },
        false,
      ),
    ).toBeNull();
  });

  it("retains the accepted submit snapshot for native echo detection", () => {
    const snapshot = { eventCount: 9, value: "corrected", selection: null };
    const accepted = reconcileComposerSubmitSnapshot(8, [], snapshot, true);
    expect(accepted).not.toBeNull();
    if (!accepted) return;
    expect(isComposerNativeEcho("corrected", null, accepted.eventCount, accepted.snapshots)).toBe(
      true,
    );
  });
});
