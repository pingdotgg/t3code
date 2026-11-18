import { describe, expect, it } from "vite-plus/test";

import {
  arrangeSurfaceActions,
  parseMenuLayer,
  type RightPanelMenuItemId,
  setMenuChoice,
} from "./menu.logic";

// Today's menu: the upstream items' own letters, then the fork's Replies, Dashboard and Whiteboard.
const TODAY: ReadonlyArray<readonly [RightPanelMenuItemId, string]> = [
  ["browser", "B"],
  ["terminal", "T"],
  ["files", "F"],
  ["diff", "D"],
  ["pull-request", "P"],
  ["pull-requests", "L"],
  ["device", "M"],
  ["side-chat", "S"],
  ["replies", ""],
  ["dashboard", ""],
  ["whiteboard", "W"],
];

const actions = (disabled: ReadonlyArray<RightPanelMenuItemId>) =>
  TODAY.map(([id, shortcut]) => ({
    id,
    shortcut,
    available: !disabled.includes(id),
    label: `${id} label`,
  }));

describe("arrangeSurfaceActions", () => {
  it.each<{
    name: string;
    machine?: Record<string, unknown>;
    browser?: Record<string, unknown>;
    disabled?: ReadonlyArray<RightPanelMenuItemId>;
    letters?: Partial<Record<RightPanelMenuItemId, string>>;
    hidden?: ReadonlyArray<RightPanelMenuItemId>;
  }>([
    { name: "empty layers keep today's letters" },
    {
      name: "empty layers keep today's letters on disabled items",
      disabled: ["browser", "diff", "side-chat", "whiteboard"],
    },
    {
      name: "unknown ids and fields that do not parse change nothing",
      machine: { future: { hidden: true, key: "B" }, files: "hidden", diff: [] },
      browser: { browser: { hidden: "yes", key: "BB" }, terminal: { key: "é" } },
    },
    {
      name: "the machine hides items and the browser shows one again",
      machine: { files: { hidden: true }, diff: { hidden: true } },
      browser: { diff: { hidden: false } },
      hidden: ["files"],
    },
    {
      name: "no letter is a choice, not inheritance",
      machine: { terminal: { key: "X" } },
      browser: { terminal: { key: "" } },
      letters: { terminal: "" },
    },
    {
      name: "a browser letter, upper-cased, beats a built-in one",
      browser: { whiteboard: { key: "f" } },
      letters: { whiteboard: "F", files: "" },
    },
    {
      name: "a machine letter beats a built-in one",
      machine: { dashboard: { key: "B" } },
      letters: { dashboard: "B", browser: "" },
    },
    {
      name: "a browser letter beats a machine one",
      machine: { dashboard: { key: "Q" } },
      browser: { replies: { key: "Q" } },
      letters: { replies: "Q" },
    },
    {
      name: "the earlier item wins a tie within a layer",
      browser: { dashboard: { key: "Q" }, replies: { key: "Q" } },
      letters: { replies: "Q" },
    },
    {
      name: "an available item keeps its letter over a disabled item's browser choice",
      browser: { whiteboard: { key: "B" } },
      disabled: ["whiteboard"],
      letters: { whiteboard: "" },
    },
    {
      name: "among disabled items the layer that set the letter wins",
      machine: { device: { key: "D" } },
      disabled: ["diff", "device"],
      letters: { device: "D", diff: "" },
    },
    {
      name: "an item gets its letter back where the winner is hidden",
      browser: { whiteboard: { key: "F", hidden: true } },
      hidden: ["whiteboard"],
    },
    {
      name: "every item can be hidden",
      machine: Object.fromEntries(TODAY.map(([id]) => [id, { hidden: true }])),
      hidden: TODAY.map(([id]) => id),
    },
  ])("$name", ({ machine = {}, browser = {}, disabled = [], letters = {}, hidden = [] }) => {
    const input = actions(disabled);
    const expected = input
      .filter((action) => !hidden.includes(action.id))
      .map((action) => ({ ...action, shortcut: letters[action.id] ?? action.shortcut }));

    expect(arrangeSurfaceActions(input, parseMenuLayer(machine), parseMenuLayer(browser))).toEqual(
      expected,
    );
  });
});

describe("setMenuChoice", () => {
  it("replaces one item's choice, removes an empty one and keeps unknown ids", () => {
    const layer = { files: { hidden: true, key: "Q" }, future: { key: "Z" } };
    expect(setMenuChoice(layer, "files", { key: "Q" })).toEqual({
      files: { key: "Q" },
      future: { key: "Z" },
    });
    expect(setMenuChoice(layer, "files", {})).toEqual({ future: { key: "Z" } });
  });

  it("starts a new layer when the stored one is malformed", () => {
    expect(setMenuChoice(null, "files", { hidden: true })).toEqual({ files: { hidden: true } });
  });
});

describe("parseMenuLayer", () => {
  it.each([null, "files", 3, ["files"]])("reads a malformed stored layer %j as empty", (raw) => {
    expect(parseMenuLayer(raw)).toEqual({});
  });
});
