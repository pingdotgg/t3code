import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ContributionStatusSnapshot, contributionStatusSourceKey } from "./contributionStatus.ts";

const decodeSnapshot = Schema.decodeUnknownSync(ContributionStatusSnapshot);

const piEntry = (items: ReadonlyArray<unknown>) => ({
  threadId: "thread-1",
  source: {
    kind: "provider-session",
    providerSessionId: "session-1",
    providerInstanceId: "pi",
    driver: "pi",
  },
  items,
});

describe("ContributionStatusSnapshot", () => {
  it("decodes a tone from a newer server as neutral instead of dropping the item", () => {
    const snapshot = decodeSnapshot({
      entries: [piEntry([{ key: "build", text: "Building", tone: "celebrate" }])],
    });
    expect(snapshot.entries[0]?.items).toEqual([
      { key: "build", text: "Building", tone: "neutral" },
    ]);
  });

  it("drops entries an older client cannot decode and keeps the rest", () => {
    const snapshot = decodeSnapshot({
      entries: [
        {
          ...piEntry([{ key: "a", text: "From a plugin" }]),
          source: { kind: "extension-host", hostId: "x" },
        },
        piEntry([{ key: "a", text: "x".repeat(81) }]),
        piEntry([{ key: "mode", text: "plan" }]),
      ],
    });
    expect(snapshot.entries.map((entry) => entry.items)).toEqual([[{ key: "mode", text: "plan" }]]);
  });

  it("decodes plugin entries and keys them by plugin id, not display name", () => {
    const source = { kind: "plugin", pluginId: "acme.notifier", name: "Notifier" } as const;
    const snapshot = decodeSnapshot({
      entries: [{ threadId: "thread-1", source, items: [{ key: "a", text: "Done" }] }],
    });
    expect(snapshot.entries[0]?.source).toEqual(source);
    expect(contributionStatusSourceKey({ ...source, name: "Renamed" })).toBe(
      contributionStatusSourceKey(source),
    );
  });

  it("rejects an entry with more items than one source may set", () => {
    const items = Array.from({ length: 9 }, (_, index) => ({ key: `k${index}`, text: "on" }));
    expect(decodeSnapshot({ entries: [piEntry(items)] }).entries).toEqual([]);
  });
});
