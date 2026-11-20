import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import type { ClientProfileSurface } from "./keys.ts";
import {
  adoptSyncedClientProfileSidecar,
  claimThisDeviceClientProfileSidecar,
  ClientProfileSidecarSchema,
  compareClientProfileEntries,
  emptyClientProfileSidecar,
  hashClientProfileValue as hash,
  needsClientProfileChoice,
  planClientProfileSync,
  recordAppliedClientProfileEntries,
  seedClientProfileSidecar,
  stampClientProfileChange,
  UNPUBLISHED_CHANGED_AT,
  type ClientProfileEntry,
  type ClientProfileLocalRead,
  type ClientProfileSidecar,
} from "./merge.ts";

const decodeSidecar = Schema.decodeSync(ClientProfileSidecarSchema);
const decodeUnknownSidecar = Schema.decodeUnknownSync(ClientProfileSidecarSchema);

const D: ClientProfileSurface = { kind: "desktop", os: "mac" };
const B: ClientProfileSurface = { kind: "browser", os: "mac" };
const M: ClientProfileSurface = { kind: "mobile" };

const entry = (value: unknown, changedAt: number, by: string): ClientProfileEntry => ({
  value,
  changedAt,
  by,
});
const read = (
  values: Record<string, unknown>,
  completePrefixes: string[] = [],
): ClientProfileLocalRead => ({ values, completePrefixes });
const sidecarWith = (
  entries: ClientProfileSidecar["entries"],
  highestSeen = 0,
): ClientProfileSidecar => ({ ...emptyClientProfileSidecar("dev-a"), highestSeen, entries });
const tracked = (value: unknown, changedAt: number, by = "dev-a") => ({
  changedAt,
  by,
  hash: hash(value),
});

describe("client profile merge", () => {
  it("newest change wins and equal stamps are ordered by device", () => {
    expect(
      compareClientProfileEntries({ changedAt: 10, by: "x" }, { changedAt: 9, by: "z" }),
    ).toBeGreaterThan(0);
    expect(
      compareClientProfileEntries({ changedAt: 10, by: "y" }, { changedAt: 10, by: "x" }),
    ).toBeGreaterThan(0);
    expect(
      compareClientProfileEntries({ changedAt: 10, by: "x" }, { changedAt: 10, by: "x" }),
    ).toBe(0);
    expect(
      compareClientProfileEntries({ changedAt: 10, by: "a" }, { changedAt: 10, by: "B" }),
    ).toBeGreaterThan(0);
  });

  it("stamps after the highest seen stamp even when the clock is behind", () => {
    expect(stampClientProfileChange(1000, 5000)).toBe(5001);
    expect(stampClientProfileChange(9000, 5000)).toBe(9000);
  });

  it("hash ignores key order", () => {
    expect(hash({ a: 1, b: { c: [1, { y: 1, x: 2 }], d: null } })).toBe(
      hash({ b: { d: null, c: [1, { x: 2, y: 1 }] }, a: 1 }),
    );
    expect(hash(null)).not.toBe(hash("null"));
    expect(hash({ a: undefined, b: 1 })).toBe(hash({ b: 1 }));
    expect(hash([1, 2])).not.toBe(hash([2, 1]));
    expect(hash("x")).toMatch(/^[0-9a-f]+$/);
  });

  it("applies a newer remote value and records it only once the store holds it", () => {
    const sidecar = sidecarWith({ chatWidth: tracked("comfortable", 100) });
    const remote = entry("wide", 200, "dev-b");
    const plan = planClientProfileSync({
      surface: B,
      now: 150,
      sidecar,
      local: read({ chatWidth: "comfortable" }),
      servers: [{ environmentId: "s1", document: { chatWidth: remote } }],
    });
    expect(plan.apply).toEqual({ chatWidth: remote });
    expect(plan.sidecar.entries.chatWidth?.changedAt).toBe(100);
    expect(plan.push).toEqual([]);

    const stale = recordAppliedClientProfileEntries({
      surface: B,
      sidecar: plan.sidecar,
      applied: plan.apply,
      stored: { chatWidth: "comfortable" },
    });
    expect(stale.entries.chatWidth?.changedAt).toBe(100);
    const stored = recordAppliedClientProfileEntries({
      surface: B,
      sidecar: plan.sidecar,
      applied: plan.apply,
      stored: { chatWidth: "wide" },
    });
    expect(stored.entries.chatWidth).toEqual({ changedAt: 200, by: "dev-b", hash: hash("wide") });
  });

  it("stamps a local change and pushes it to every server", () => {
    const old = entry("comfortable", 100, "dev-a");
    const plan = planClientProfileSync({
      surface: B,
      now: 120,
      sidecar: sidecarWith({ chatWidth: tracked("comfortable", 100) }, 150),
      local: read({ chatWidth: "wide" }),
      servers: [
        { environmentId: "s1", document: { chatWidth: old } },
        { environmentId: "s2", document: {} },
      ],
    });
    const stamped = entry("wide", 151, "dev-a");
    expect(plan.push).toEqual([
      { environmentId: "s1", entries: { chatWidth: stamped } },
      { environmentId: "s2", entries: { chatWidth: stamped } },
    ]);
    expect(plan.sidecar.highestSeen).toBe(151);
    expect(plan.sidecar.entries.chatWidth).toEqual({
      changedAt: 151,
      by: "dev-a",
      hash: hash("wide"),
    });
  });

  it("baselines an untracked key without publishing it", () => {
    const local = read({ diffLayout: "split" });
    const plan = planClientProfileSync({
      surface: B,
      now: 10,
      sidecar: sidecarWith({}),
      local,
      servers: [{ environmentId: "s1", document: {} }],
    });
    expect(plan.sidecar.entries.diffLayout).toEqual({
      changedAt: UNPUBLISHED_CHANGED_AT,
      by: "dev-a",
      hash: hash("split"),
    });
    expect(plan.push).toEqual([]);

    const remote = entry("unified", 5, "dev-b");
    const later = planClientProfileSync({
      surface: B,
      now: 10,
      sidecar: plan.sidecar,
      local,
      servers: [{ environmentId: "s1", document: { diffLayout: remote } }],
    });
    expect(later.apply).toEqual({ diffLayout: remote });
  });

  it("pushes to a server what another connected server has newer, including keys this surface never applies", () => {
    const newer = entry("wide", 300, "dev-b");
    const plan = planClientProfileSync({
      surface: M,
      now: 10,
      sidecar: sidecarWith({}),
      local: read({}),
      servers: [
        { environmentId: "s1", document: { chatWidth: newer } },
        { environmentId: "s2", document: { chatWidth: entry("compact", 100, "dev-b") } },
      ],
    });
    expect(plan.push).toEqual([{ environmentId: "s2", entries: { chatWidth: newer } }]);
    expect(plan.apply).toEqual({});
    expect(plan.sidecar.entries.chatWidth).toBeUndefined();
  });

  it("turns custom themes from two devices into a union and lets a deletion beat an older edit", () => {
    const sidecar = sidecarWith({ "customTheme.a": tracked("A", 100) });
    const local = read({ "customTheme.a": "A" }, ["customTheme."]);
    const theirs = entry("B", 200, "dev-b");
    const union = planClientProfileSync({
      surface: D,
      now: 10,
      sidecar,
      local,
      servers: [{ environmentId: "s1", document: { "customTheme.b": theirs } }],
    });
    expect(union.apply).toEqual({ "customTheme.b": theirs });
    expect(union.push).toEqual([
      { environmentId: "s1", entries: { "customTheme.a": entry("A", 100, "dev-a") } },
    ]);

    const deletion = entry(null, 300, "dev-b");
    const deleted = planClientProfileSync({
      surface: D,
      now: 10,
      sidecar,
      local,
      servers: [{ environmentId: "s1", document: { "customTheme.a": deletion } }],
    });
    expect(deleted.apply).toEqual({ "customTheme.a": deletion });
  });

  it("infers a deleted custom theme only when the library was fully read", () => {
    const sidecar = sidecarWith({ "customTheme.a": tracked("A", 100) });
    const servers = [{ environmentId: "s1", document: {} }];
    const partial = planClientProfileSync({
      surface: D,
      now: 500,
      sidecar,
      local: read({}, []),
      servers,
    });
    expect(partial.push).toEqual([]);
    expect(partial.sidecar.entries).toEqual(sidecar.entries);

    const full = planClientProfileSync({
      surface: D,
      now: 500,
      sidecar,
      local: read({}, ["customTheme."]),
      servers,
    });
    expect(full.push).toEqual([
      { environmentId: "s1", entries: { "customTheme.a": entry(null, 500, "dev-a") } },
    ]);
    expect(full.sidecar.entries["customTheme.a"]?.hash).toBe(hash(null));
  });

  it("no echo after applying", () => {
    const sidecar = sidecarWith({ chatWidth: tracked("comfortable", 100) });
    const servers = [{ environmentId: "s1", document: { chatWidth: entry("wide", 200, "dev-b") } }];
    const first = planClientProfileSync({
      surface: B,
      now: 10,
      sidecar,
      local: read({ chatWidth: "comfortable" }),
      servers,
    });
    const recorded = recordAppliedClientProfileEntries({
      surface: B,
      sidecar: first.sidecar,
      applied: first.apply,
      stored: { chatWidth: "wide" },
    });
    const second = planClientProfileSync({
      surface: B,
      now: 20,
      sidecar: recorded,
      local: read({ chatWidth: "wide" }),
      servers,
    });
    expect(second.push).toEqual([]);
    expect(second.apply).toEqual({});
    expect(second.sidecar).toEqual(recorded);
  });

  it("seeds own non-default values at zero", () => {
    const sidecar = seedClientProfileSidecar({
      surface: B,
      sidecar: { ...sidecarWith({}), choicePending: true },
      local: read({ chatWidth: "wide", diffLayout: "unified", "customTheme.a": "A" }),
      defaults: { chatWidth: "comfortable", diffLayout: "unified" },
    });
    expect(sidecar.entries.chatWidth?.changedAt).toBe(0);
    expect(sidecar.entries["customTheme.a"]?.changedAt).toBe(0);
    expect(sidecar.entries.diffLayout?.changedAt).toBe(UNPUBLISHED_CHANGED_AT);
    expect(sidecar.choicePending).toBe(false);
  });

  it("adopting synced settings fills only the gaps at zero", () => {
    const sidecar = adoptSyncedClientProfileSidecar({
      surface: B,
      sidecar: { ...sidecarWith({}), choicePending: true },
      local: read({ chatWidth: "wide", diffLayout: "split" }),
      defaults: { chatWidth: "comfortable", diffLayout: "unified" },
      servers: [{ environmentId: "s1", document: { chatWidth: entry("compact", 50, "dev-b") } }],
    });
    expect(sidecar.entries.chatWidth?.changedAt).toBe(UNPUBLISHED_CHANGED_AT);
    expect(sidecar.entries.diffLayout?.changedAt).toBe(0);
    expect(sidecar.choicePending).toBe(false);
  });

  it("using this device's settings stamps every own key past every server stamp and leaves other surfaces' keys alone", () => {
    const sidecar = claimThisDeviceClientProfileSidecar({
      surface: M,
      now: 50,
      sidecar: { ...sidecarWith({}, 100), choicePending: true },
      local: read({ themeMode: "dark", themeLight: "a", wordWrap: "wide" }),
      servers: [
        {
          environmentId: "s1",
          document: {
            themeMode: entry("light", 500, "dev-b"),
            wordWrap: entry("compact", 900, "dev-b"),
          },
        },
      ],
    });
    expect(sidecar.entries.themeMode?.changedAt).toBe(901);
    expect(sidecar.entries.themeLight?.changedAt).toBe(901);
    expect(sidecar.entries.wordWrap).toBeUndefined();
    expect(sidecar.highestSeen).toBe(901);
    expect(sidecar.choicePending).toBe(false);
  });

  it("needs a choice only when a document holds a key of this surface", () => {
    const docs = (key: string) => [
      { environmentId: "s1", document: { [key]: entry("x", 1, "dev-b") } },
    ];
    expect(needsClientProfileChoice(M, docs("wordWrap"))).toBe(false);
    expect(needsClientProfileChoice(M, docs("themeMode"))).toBe(true);
    expect(needsClientProfileChoice(D, docs("fontFamilyCode@windows"))).toBe(false);
    expect(needsClientProfileChoice(D, docs("fontFamilyCode@mac"))).toBe(true);
  });

  it("keeps publishing editor themes from computers", () => {
    const plan = planClientProfileSync({
      surface: B,
      now: 40,
      sidecar: sidecarWith({}),
      local: read({ "customTheme.nord": "N" }),
      servers: [{ environmentId: "s1", document: {} }],
    });
    expect(plan.sidecar.entries["customTheme.nord"]).toEqual(tracked("N", 40));
    expect(plan.push).toEqual([
      { environmentId: "s1", entries: { "customTheme.nord": entry("N", 40, "dev-a") } },
    ]);
  });

  it("never publishes an editor theme the phone holds without a tracked entry", () => {
    const plan = planClientProfileSync({
      surface: M,
      now: 40,
      sidecar: sidecarWith({}),
      local: read({ "customTheme.nord": "N" }),
      servers: [{ environmentId: "s1", document: {} }],
    });
    expect(plan.push).toEqual([]);
    expect(plan.sidecar.entries["customTheme.nord"]?.changedAt ?? -1).toBeLessThan(0);
  });

  it("applies a computer's editor theme over a different local copy on the phone", () => {
    const remote = entry("C", 200, "desk");
    const plan = planClientProfileSync({
      surface: M,
      now: 40,
      sidecar: sidecarWith({ "customTheme.nord": tracked("A", 100, "desk") }),
      local: read({ "customTheme.nord": "B" }),
      servers: [{ environmentId: "s1", document: { "customTheme.nord": remote } }],
    });
    expect(plan.apply["customTheme.nord"]).toEqual(remote);
    expect(plan.push).toEqual([]);
  });

  it("never pushes a deletion of an editor theme missing on the phone", () => {
    const plan = planClientProfileSync({
      surface: M,
      now: 500,
      sidecar: sidecarWith({ "customTheme.nord": tracked("N", 100, "desk") }),
      local: read({}, ["customTheme."]),
      servers: [{ environmentId: "s1", document: {} }],
    });
    expect(plan.push).toEqual([]);
  });

  it("relays an unchanged editor theme from the phone with its original stamp", () => {
    const stamp = entry("N", 500, "desk");
    const plan = planClientProfileSync({
      surface: M,
      now: 40,
      sidecar: sidecarWith({ "customTheme.nord": tracked("N", 500, "desk") }),
      local: read({ "customTheme.nord": "N" }),
      servers: [
        { environmentId: "a", document: { "customTheme.nord": stamp } },
        { environmentId: "b", document: {} },
      ],
    });
    expect(plan.push).toEqual([{ environmentId: "b", entries: { "customTheme.nord": stamp } }]);
  });

  it("claiming this device's settings on the phone skips editor themes", () => {
    const sidecar = claimThisDeviceClientProfileSidecar({
      surface: M,
      now: 50,
      sidecar: { ...sidecarWith({}), choicePending: true },
      local: read({ "customTheme.nord": "N", themeDark: "dusk" }),
      servers: [],
    });
    expect(sidecar.entries["customTheme.nord"]).toBeUndefined();
    expect(sidecar.entries.themeDark).toEqual(tracked("dusk", 50));
  });

  it("seeding on the phone skips editor themes", () => {
    const input = {
      surface: M,
      sidecar: { ...sidecarWith({}), choicePending: true },
      local: read({ "customTheme.nord": "N" }),
      defaults: {},
    };
    expect(seedClientProfileSidecar(input).entries["customTheme.nord"]).toBeUndefined();
    const adopted = adoptSyncedClientProfileSidecar({
      ...input,
      servers: [{ environmentId: "s1", document: { "customTheme.nord": entry("N", 5, "desk") } }],
    });
    expect(adopted.entries["customTheme.nord"]).toBeUndefined();
  });

  it("a server holding only editor themes needs no choice on the phone", () => {
    const servers = [
      { environmentId: "s1", document: { "customTheme.nord": entry("N", 1, "desk") } },
    ];
    expect(needsClientProfileChoice(M, servers)).toBe(false);
    expect(needsClientProfileChoice(D, servers)).toBe(true);
  });

  it("decodes a stored sidecar and rejects a malformed one", () => {
    const stored = sidecarWith({ diffLayout: { changedAt: -1, by: "dev-a", hash: "ab" } }, 7);
    expect(decodeSidecar(stored)).toEqual(stored);
    expect(() => decodeUnknownSidecar({ deviceId: 5 })).toThrow();
  });
});
