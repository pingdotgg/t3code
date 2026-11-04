import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  PluginViewMessage,
  PluginViewsManifest,
  PluginViewsSnapshot,
  pluginViewHandler,
} from "./pluginViews.ts";

const decodeManifest = Schema.decodeUnknownExit(PluginViewsManifest);
const decodeSnapshot = Schema.decodeUnknownExit(PluginViewsSnapshot);
const decodeMessage = Schema.decodeUnknownExit(PluginViewMessage);

const view = {
  installationId: "installation-1",
  generation: 2,
  pluginId: "acme.board",
  pluginName: "Board",
  viewId: "board",
  title: "Board",
  placement: "side-panel",
};

describe("PluginViewsManifest", () => {
  const declaration = {
    id: "board",
    title: "Board",
    placement: "side-panel",
    script: "dist/board.js",
  };

  it("reads views from t3-plugin.json and ignores the plugin manifest's own keys", () => {
    expect(decodeManifest({ id: "acme.board", entry: "main.mjs" })).toEqual(
      Exit.succeed({ views: [] }),
    );
    expect(decodeManifest({ views: [{ ...declaration, style: "dist/board.css" }] })).toEqual(
      Exit.succeed({ views: [{ ...declaration, style: "dist/board.css" }] }),
    );
  });

  it("refuses placements this version cannot show and paths outside the plugin", () => {
    for (const invalid of [
      { ...declaration, placement: "bottom-dock" },
      { ...declaration, script: "../board.js" },
      { ...declaration, script: "dist/../../board.js" },
      { ...declaration, script: "/abs/board.js" },
      { ...declaration, script: "dist/board.mjs" },
      { ...declaration, id: "Board" },
    ]) {
      expect(Exit.isFailure(decodeManifest({ views: [invalid] }))).toBe(true);
    }
    expect(
      Exit.isFailure(
        decodeManifest({
          views: Array.from({ length: 9 }, (_, index) => ({ ...declaration, id: `v${index}` })),
        }),
      ),
    ).toBe(true);
  });
});

describe("PluginViewsSnapshot from a newer server", () => {
  it("keeps views with placements or fields this client does not know and drops malformed ones", () => {
    const decoded = decodeSnapshot({
      views: [
        { ...view, placement: "bottom-dock", icon: "grid" },
        { ...view, generation: "two" },
      ],
      problems: [{ installationId: "installation-2", generation: 1, message: "bad", code: "x" }],
    });
    expect(decoded).toEqual(
      Exit.succeed({
        views: [{ ...view, placement: "bottom-dock" }],
        problems: [{ installationId: "installation-2", generation: 1, message: "bad" }],
      }),
    );
  });
});

describe("PluginViewMessage", () => {
  it("accepts the bridge's view messages and nothing else", () => {
    expect(decodeMessage({ _tag: "call", id: 1, handler: "stats", input: { a: [1] } })).toEqual(
      Exit.succeed({ _tag: "call", id: 1, handler: "stats", input: { a: [1] } }),
    );
    for (const invalid of [
      { _tag: "call", id: 0, handler: "stats", input: null },
      { _tag: "call", id: 1, handler: "view:other:stats", input: null },
      { _tag: "result", id: 1, value: null },
      { _tag: "connect" },
    ]) {
      expect(Exit.isFailure(decodeMessage(invalid))).toBe(true);
    }
  });

  it("names the plugin handler a view call reaches", () => {
    expect(pluginViewHandler("board", "stats")).toBe("view:board:stats");
  });
});
