import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId } from "@t3tools/contracts";

import {
  deliverableHighlight,
  hoverOriginInFrame,
  insertCandidates,
  isBoardOffered,
  isFromBoardFrame,
  keepPendingFor,
} from "./boardChannel.logic";

const OWN = "https://board.example.com";
const frameWindow = { name: "board frame" };

describe("isFromBoardFrame", () => {
  it.each([
    { name: "the registered frame on this origin", origin: OWN, source: frameWindow, ok: true },
    { name: "another origin", origin: "https://evil.example.com", source: frameWindow, ok: false },
    { name: "another window on this origin", origin: OWN, source: { name: "other" }, ok: false },
    { name: "no frame registered", origin: OWN, source: null, frame: null, ok: false },
  ])("$name: $ok", ({ origin, source, frame = frameWindow, ok }) => {
    expect(isFromBoardFrame({ origin, ownOrigin: OWN, source, frameWindow: frame })).toBe(ok);
  });
});

describe("pending highlight", () => {
  const pending = { threadKey: "env:a", ref: "board://r/1,2,3,4" };

  it.each([
    { name: "a ready frame of the same thread", frame: { threadKey: "env:a", ready: true } },
    { name: "a frame still loading", frame: { threadKey: "env:a", ready: false }, held: true },
    { name: "another thread's frame", frame: { threadKey: "env:b", ready: true }, held: true },
    { name: "no frame", frame: null, held: true },
  ])("is delivered to $name only when ready and matching", ({ frame, held }) => {
    expect(deliverableHighlight(pending, frame)).toBe(held ? null : pending.ref);
  });

  it("survives its own thread's frame and is dropped by another thread's", () => {
    expect(keepPendingFor(pending, "env:a")).toBe(pending);
    expect(keepPendingFor(pending, "env:b")).toBeNull();
  });
});

describe("insertCandidates", () => {
  const main = { id: "main", threadKey: "env:a", main: true, connected: true };
  const subThread = { id: "sub", threadKey: "env:a", main: false, connected: true };
  const sideChat = { id: "side", threadKey: "env:side", main: true, connected: true };
  const gone = { ...sideChat, id: "gone", connected: false };

  it.each([
    {
      name: "the last focused composer, then the main one",
      last: subThread,
      expected: ["sub", "main"],
    },
    { name: "a focused side chat, then the main one", last: sideChat, expected: ["side", "main"] },
    { name: "the main composer when nothing was focused", last: null, expected: ["main"] },
    { name: "the main composer when the focused one is gone", last: gone, expected: ["main"] },
    { name: "the main composer once when it was focused", last: main, expected: ["main"] },
  ])("tries $name", ({ last, expected }) => {
    expect(
      insertCandidates([main, subThread, sideChat, gone], last, "env:a").map((c) => c.id),
    ).toEqual(expected);
  });

  it("offers none when the panel thread has no main composer", () => {
    expect(insertCandidates([subThread, sideChat], null, "env:a")).toEqual([]);
  });
});

describe("isBoardOffered", () => {
  const primary = EnvironmentId.make("primary");
  const offered = {
    boardHost: true,
    topWindow: true,
    threadEnvironmentId: primary,
    primaryEnvironmentId: primary,
    projectRoot: "/srv/project",
  };

  it.each([
    { name: "a project thread of this machine on a board host", input: {}, ok: true },
    { name: "a machine that is not a board host", input: { boardHost: false }, ok: false },
    { name: "T3 inside the board page's chat slot", input: { topWindow: false }, ok: false },
    {
      name: "a thread of a linked environment",
      input: { threadEnvironmentId: EnvironmentId.make("linked") },
      ok: false,
    },
    { name: "no primary environment", input: { primaryEnvironmentId: null }, ok: false },
    { name: "a thread without a project", input: { projectRoot: null }, ok: false },
  ])("$name: $ok", ({ input, ok }) => {
    expect(isBoardOffered({ ...offered, ...input })).toBe(ok);
  });
});

describe("hoverOriginInFrame", () => {
  it("starts at the chip's left edge, mid height, in the frame's viewport", () => {
    expect(
      hoverOriginInFrame({ left: 120, top: 400, height: 20 }, { left: 700, top: 48, height: 900 }),
    ).toEqual({ x: -580, y: 362 });
  });
});
