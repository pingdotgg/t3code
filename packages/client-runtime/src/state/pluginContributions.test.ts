import {
  PluginInstallation,
  PluginInstallationId,
  PluginInstallationManifest,
  type PluginAction,
  PluginActionId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import { describePluginCapabilities, describePluginContributions } from "./pluginContributions.ts";

const decodeManifest = Schema.decodeUnknownSync(PluginInstallationManifest);

const manifest = (fields: Record<string, unknown>) =>
  decodeManifest({
    id: "acme.notifier",
    name: "Notifier",
    version: "1.0.0",
    capabilities: [],
    proposedApi: true,
    ...fields,
  });

const FULL = manifest({
  capabilities: ["actions", "tools", "views", "settings", "events"],
  actions: [
    {
      name: "summarize",
      title: "Summarize thread",
      target: "thread",
      placements: ["thread-menu", "composer-slash"],
    },
  ],
  tools: [
    {
      name: "word_count",
      description: "Count words.",
      inputSchema: { type: "object" },
      sideEffect: "read",
    },
  ],
  settings: [
    { type: "secret", key: "token", label: "API token" },
    { type: "boolean", key: "loud", label: "Loud", description: "Play a sound." },
  ],
});

const action = (pluginId: string): PluginAction => ({
  id: PluginActionId.make(`${pluginId}:1`),
  pluginId,
  pluginName: pluginId,
  name: "summarize",
  title: "Summarize thread",
  target: "thread",
  placements: ["thread-menu"],
});

const omitted = { plugins: 2, actions: 9 };

const decodeInstallation = Schema.decodeUnknownSync(PluginInstallation);
const DIGEST = `sha256:${"a".repeat(64)}`;

/** An installation of FULL; by default enabled, approved, and running. A null `hostState` leaves it out. */
const installed = (fields: Record<string, unknown> = {}) => {
  const { hostState = { _tag: "running" }, ...rest } = fields;
  return decodeInstallation({
    installationId: "installation-1",
    generation: 2,
    directory: "/srv/plugins/notifier",
    manifest: FULL,
    source: { digest: DIGEST, files: 3, bytes: 2048 },
    problem: null,
    inspectedAt: "2026-10-04T00:00:00.000Z",
    consent: {
      digest: DIGEST,
      capabilities: FULL.capabilities,
      grantedAt: "2026-10-04T00:00:00.000Z",
    },
    enabled: true,
    addedAt: "2026-10-04T00:00:00.000Z",
    ...(hostState === null ? {} : { hostState }),
    ...rest,
  });
};

describe("describePluginContributions", () => {
  it("lists what the manifest declares, without starting the plugin", () => {
    const groups = describePluginContributions({
      manifest: FULL,
      installation: null,
      actions: null,
      views: null,
    });
    expect(groups.map((group) => group.kind)).toEqual([
      "actions",
      "tools",
      "views",
      "settings",
      "events",
    ]);
    expect(groups[0]?.items).toEqual([
      {
        key: "summarize",
        title: "Summarize thread",
        detail: "Runs on a thread · Thread menu, /summarize",
      },
    ]);
    expect(groups[1]?.items[0]).toMatchObject({
      title: "word_count",
      detail: "Reads only · Count words.",
    });
    expect(groups[3]?.items.map((item) => item.detail)).toEqual([
      "Secret, kept on the server",
      "On or off · Play a sound.",
    ]);
    // View titles are not in the manifest summary; they come from the views snapshot once enabled.
    expect(groups[2]).toMatchObject({ items: [], notice: expect.stringContaining("enabled") });
  });

  it("lists nothing for a plugin that declares no contributions", () => {
    expect(
      describePluginContributions({
        manifest: manifest({}),
        installation: null,
        actions: null,
        views: null,
      }),
    ).toEqual([]);
  });

  it("says when the environment's action limit left this plugin out", () => {
    const left = describePluginContributions({
      manifest: FULL,
      installation: installed(),
      actions: { actions: [action("other.plugin")], omitted },
      views: null,
    });
    expect(left[0]?.notice).toBe(
      "Not offered: this environment's action limit left out 2 plugins with 9 actions, including this one. Disable another plugin with actions to make room.",
    );
  });

  it("has no notice when its actions are offered, it is not installed, or nothing was left out", () => {
    const notice = (input: Omit<Parameters<typeof describePluginContributions>[0], "manifest">) =>
      describePluginContributions({ manifest: FULL, ...input })[0]?.notice;
    expect(
      notice({
        installation: installed(),
        actions: { actions: [action("acme.notifier")], omitted },
        views: null,
      }),
    ).toBeNull();
    expect(
      notice({ installation: null, actions: { actions: [], omitted }, views: null }),
    ).toBeNull();
    expect(notice({ installation: installed(), actions: { actions: [] }, views: null })).toBeNull();
    expect(notice({ installation: installed(), actions: null, views: null })).toBeNull();
  });

  it("blames the limit only for an installation the server counts towards it", () => {
    // Overflow elsewhere: the snapshot omits other plugins, and offers none of this one's actions.
    const elsewhere = { actions: [action("other.plugin")], omitted: { plugins: 1, actions: 16 } };
    const contributionsOf = (installation: PluginInstallation) =>
      describePluginContributions({
        manifest: FULL,
        installation,
        actions: elsewhere,
        views: null,
      });
    // The server never offers actions for these, so the limit did not leave them out.
    const ineligible = [
      installed({ hostState: { _tag: "quarantined", failures: 3, reason: "crashed" } }),
      installed({ hostState: { _tag: "incompatible", reason: "needs a newer T3 Code" } }),
      installed({ enabled: false, hostState: null }),
      installed({ consent: null, enabled: false, hostState: null }),
      installed({ manifest: manifest({ actions: FULL.actions }) }),
    ];
    for (const installation of ineligible) {
      const actions = contributionsOf(installation)[0];
      // Its declared actions stay listed while they are unavailable.
      expect(actions?.items.map((item) => item.key)).toEqual(["summarize"]);
      expect(actions?.notice).toBeNull();
    }
    expect(contributionsOf(installed())[0]?.notice).toContain("including this one");
    // An enabled plugin waiting on a Resume still lists the views it offers.
    const view = {
      installationId: PluginInstallationId.make("installation-1"),
      generation: 2,
      pluginId: "acme.notifier",
      pluginName: "Notifier",
      viewId: "board",
      title: "Board",
      placement: "side-panel",
    };
    expect(
      describePluginContributions({
        manifest: FULL,
        installation: ineligible[0]!,
        actions: elsewhere,
        views: { views: [view], problems: [] },
      })[2]?.items.map((item) => item.title),
    ).toEqual(["Board"]);
  });

  it("lists the views an enabled plugin offers, or why it offers none", () => {
    const installationId = PluginInstallationId.make("installation-1");
    const view = {
      installationId,
      generation: 2,
      pluginId: "acme.notifier",
      pluginName: "Notifier",
      viewId: "board",
      title: "Board",
      placement: "side-panel",
    };
    const views = (input: {
      views: Array<typeof view>;
      problems: Array<{
        installationId: typeof installationId;
        generation: number;
        message: string;
      }>;
    }) =>
      describePluginContributions({
        manifest: FULL,
        installation: installed(),
        actions: null,
        views: input,
      })[2];
    expect(views({ views: [view], problems: [] })).toMatchObject({
      items: [{ key: "board", title: "Board", detail: "Side panel on web and desktop" }],
      notice: null,
    });
    expect(
      views({
        views: [],
        problems: [{ installationId, generation: 2, message: "board.js is too large." }],
      })?.notice,
    ).toBe("board.js is too large.");
  });
});

describe("describePluginCapabilities", () => {
  it("explains every capability the server implements, in its order, and shows others as named", () => {
    const known = ["views", "settings", "tools", "events", "actions", "status"];
    // Names the server refuses get no meaning: nothing implements them.
    const unknown = ["transforms", "approvals", "notifications", "telepathy"];
    const described = describePluginCapabilities([...known, ...unknown]);
    expect(described.map((capability) => capability.name)).toEqual([...known, ...unknown]);
    for (const capability of described.slice(0, known.length))
      expect(capability.meaning, capability.name).toMatch(/\S/);
    expect(new Set(described.slice(0, known.length).map((c) => c.meaning)).size).toBe(known.length);
    expect(described.slice(known.length)).toEqual(unknown.map((name) => ({ name, meaning: null })));
    expect(describePluginCapabilities(["constructor"])).toEqual([
      { name: "constructor", meaning: null },
    ]);
    expect(describePluginCapabilities([])).toEqual([]);
  });

  it("says what the riskier capabilities let a plugin do", () => {
    const meaning = (name: string) => describePluginCapabilities([name])[0]?.meaning;
    expect(meaning("tools")).toContain("agents tools");
    expect(meaning("events")).toContain("never message contents");
  });
});
