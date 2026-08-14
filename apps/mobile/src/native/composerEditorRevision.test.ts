import { describe, expect, it } from "@effect/vitest";

import {
  acknowledgeComposerNativeEvent,
  assumeComposerControlledState,
  isComposerNativeEcho,
  pruneAcknowledgedComposerNativeEvents,
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
    // An echo payload serializes `selection: null`; classifying a controlled
    // selection as an echo of an assumed state would drop a parent caret move.
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
    // Same value, new caret: not an echo (so the selection is serialized) but
    // still stamped at the assumed revision so the editor accepts it.
    const snapshots = assumeComposerControlledState([], 3, "typed");

    expect(isComposerNativeEcho("typed", { start: 2, end: 2 }, 3, snapshots)).toBe(false);
    expect(resolveComposerControlledEventCount("typed", { start: 2, end: 2 }, 3, snapshots)).toBe(
      3,
    );
  });

  it("re-applies a parent value that round-trips back to an acknowledged state", () => {
    // Native acknowledged "typed", the parent then controlled the editor to ""
    // (a send clearing the draft) and back to "typed" (the send failed and the
    // draft was restored). The restore must be a fresh non-echo edit stamped at
    // the current revision, not an echo the editor would drop.
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
