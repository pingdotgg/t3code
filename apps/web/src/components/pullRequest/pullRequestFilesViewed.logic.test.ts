import { describe, expect, it } from "vite-plus/test";

import {
  isFileViewed,
  isStaleViewedState,
  revertFileViewedOverlay,
  settleFileViewedOverlay,
  toFileViewedStates,
  type FileViewedOverlay,
} from "./pullRequestFilesViewed.logic";

const NO_OVERLAY: FileViewedOverlay = new Map();
const NOTHING_PENDING: ReadonlySet<string> = new Set();
const NOTHING_ANSWERED: ReadonlySet<string> = new Set();

const states = toFileViewedStates({
  files: [
    { path: "a.ts", state: "viewed" },
    { path: "b.ts", state: "unviewed" },
    { path: "c.ts", state: "dismissed" },
  ],
  truncated: false,
});

describe("isFileViewed", () => {
  it("reads a file pushed to since it was cleared as unread", () => {
    expect(isFileViewed("c.ts", states, NO_OVERLAY)).toBe(false);
    expect(isStaleViewedState(states?.get("c.ts"))).toBe(true);
    expect(isStaleViewedState(states?.get("a.ts"))).toBe(false);
  });

  it("shows the press ahead of the host's answer", () => {
    expect(isFileViewed("b.ts", states, new Map([["b.ts", true]]))).toBe(true);
    expect(isFileViewed("a.ts", states, new Map([["a.ts", false]]))).toBe(false);
  });
});

describe("settleFileViewedOverlay", () => {
  it("drops a press the host has caught up on", () => {
    const settled = settleFileViewedOverlay(
      new Map([["a.ts", true]]),
      states,
      NOTHING_PENDING,
      NOTHING_ANSWERED,
    );
    expect(settled.size).toBe(0);
  });

  it("keeps a press the host cannot have heard yet", () => {
    const overlay = new Map([["a.ts", false]]);
    const settled = settleFileViewedOverlay(overlay, states, new Set(["a.ts"]), NOTHING_ANSWERED);
    expect(settled.get("a.ts")).toBe(false);
  });

  it("settles a file pushed to since it was cleared against un-ticking it", () => {
    const settled = settleFileViewedOverlay(
      new Map([["c.ts", false]]),
      states,
      NOTHING_PENDING,
      NOTHING_ANSWERED,
    );
    expect(settled.size).toBe(0);
  });

  it("drops a tick once a read has answered for it, against what the reader pressed", () => {
    const settled = settleFileViewedOverlay(
      new Map([["c.ts", true]]),
      states,
      NOTHING_PENDING,
      new Set(["c.ts"]),
    );
    expect(settled.size).toBe(0);
    expect(isFileViewed("c.ts", states, settled)).toBe(false);
    expect(isStaleViewedState(states?.get("c.ts"))).toBe(true);
  });

  it("holds a press made since the read that would otherwise answer for it", () => {
    const overlay = new Map([["c.ts", true]]);
    const settled = settleFileViewedOverlay(overlay, states, new Set(["c.ts"]), new Set(["c.ts"]));
    expect(settled.get("c.ts")).toBe(true);
  });
});

describe("revertFileViewedOverlay", () => {
  const batch = [
    { path: "a.ts", viewed: true },
    { path: "b.ts", viewed: false },
  ];
  const both = new Set(["a.ts", "b.ts"]);

  it("puts the checkbox back to the host's answer for everything the request answers for", () => {
    const overlay = new Map([
      ["a.ts", true],
      ["b.ts", false],
    ]);
    expect(revertFileViewedOverlay(overlay, batch, both).size).toBe(0);
  });

  it("leaves a press the reader made after the request went out", () => {
    const overlay = new Map([
      ["a.ts", false],
      ["b.ts", false],
    ]);
    const reverted = revertFileViewedOverlay(overlay, batch, new Set(["b.ts"]));
    expect([...reverted]).toEqual([["a.ts", false]]);
  });

  it("leaves a path a later request took over, even pressed the same way", () => {
    const overlay = new Map([["a.ts", true]]);
    expect(revertFileViewedOverlay(overlay, batch, new Set(["b.ts"]))).toBe(overlay);
  });
});
