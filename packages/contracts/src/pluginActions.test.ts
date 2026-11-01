import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { PluginManifest } from "./plugin.ts";
import { PluginActionsSnapshot } from "./pluginActions.ts";

const action = {
  id: "installation-1:1:open-dashboard",
  pluginId: "acme.dashboard",
  pluginName: "Dashboard",
  name: "open-dashboard",
  title: "Open dashboard",
  target: "thread",
  placements: ["command-palette", "thread-menu"],
};
const decodeSnapshot = Schema.decodeUnknownExit(PluginActionsSnapshot);
const decodeManifest = Schema.decodeUnknownExit(PluginManifest);

describe("PluginActionsSnapshot from a newer server", () => {
  it("drops placements and actions this client cannot offer, keeping the rest", () => {
    const decoded = decodeSnapshot({
      actions: [
        { ...action, placements: ["toolbar", "thread-menu"], icon: "rocket" },
        // A target kind this client cannot supply: the action is not offered at all.
        { ...action, id: "installation-1:1:deploy", name: "deploy", target: "selection" },
      ],
    });
    expect(Exit.isSuccess(decoded)).toBe(true);
    if (!Exit.isSuccess(decoded)) return;
    expect(decoded.value.actions).toEqual([{ ...action, placements: ["thread-menu"] }]);
  });

  it("carries what the environment bound left out, and older frames without it", () => {
    const omitted = { plugins: 2, actions: 20 };
    const decoded = decodeSnapshot({ actions: [action], omitted });
    expect(Exit.isSuccess(decoded) && decoded.value.omitted).toEqual(omitted);
    const older = decodeSnapshot({ actions: [action] });
    expect(Exit.isSuccess(older) && older.value).toEqual({ actions: [action] });
  });
});

describe("PluginManifest actions", () => {
  const manifest = {
    id: "acme.dashboard",
    name: "Dashboard",
    version: "1.0.0",
    apiVersion: 1,
    entry: "main.mjs",
    capabilities: ["actions"],
    proposedApi: true,
  };

  it("refuses a malformed or unbounded declaration", () => {
    const declaration = {
      name: "open",
      title: "Open",
      target: "thread",
      placements: ["thread-menu"],
    };
    expect(Exit.isSuccess(decodeManifest({ ...manifest, actions: [declaration] }))).toBe(true);
    for (const actions of [
      [{ ...declaration, name: "Open Dashboard" }],
      [{ ...declaration, title: "x".repeat(61) }],
      [{ ...declaration, placements: [] }],
      [{ ...declaration, target: "selection" }],
      Array.from({ length: 17 }, (_, index) => ({ ...declaration, name: `open-${index}` })),
    ]) {
      expect(Exit.isFailure(decodeManifest({ ...manifest, actions }))).toBe(true);
    }
  });
});
