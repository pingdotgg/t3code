import { describe, expect, it, vi } from "@effect/vitest";
import type { SharePayload } from "expo-sharing";

import type { IncomingShareDraft } from "./incoming-share-model";
import { IncomingShareInbox, type IncomingShareInboxDependencies } from "./incoming-share-inbox";

const PAYLOAD: SharePayload = {
  shareType: "text",
  mimeType: "text/plain",
  value: "Fix this",
};

function draft(id: string, createdAt = "2026-07-16T08:00:00.000Z"): IncomingShareDraft {
  return {
    schemaVersion: 1,
    id,
    createdAt,
    text: PAYLOAD.value,
    attachments: [],
    warnings: [],
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createHarness(overrides: Partial<IncomingShareInboxDependencies> = {}) {
  const persisted = new Map<string, IncomingShareDraft>();
  let payloads: ReadonlyArray<SharePayload> = [PAYLOAD];
  const dependencies: IncomingShareInboxDependencies = {
    loadDrafts: async () => [...persisted.values()],
    writeDraft: async (value) => {
      persisted.set(value.id, value);
    },
    removeDraft: async (shareId) => {
      persisted.delete(shareId);
    },
    getPayloads: () => payloads,
    clearPayloads: () => {
      payloads = [];
    },
    buildDraft: async ({ id, createdAt }) => ({
      draft: draft(id, createdAt),
      cleanup: async () => undefined,
    }),
    idForPayloads: async () => "share-stable",
    now: () => "2026-07-16T08:00:00.000Z",
    ...overrides,
  };
  return { inbox: new IncomingShareInbox(dependencies), persisted };
}

describe("IncomingShareInbox", () => {
  it("coalesces a replay of an already-persisted native handoff", async () => {
    const buildDraft = vi.fn(async ({ id, createdAt }) => ({
      draft: draft(id, createdAt),
      cleanup: async () => undefined,
    }));
    const cleanupReplayedPayloads = vi.fn(async () => undefined);
    const { inbox, persisted } = createHarness({ buildDraft, cleanupReplayedPayloads });
    persisted.set("share-stable", draft("share-stable"));

    await expect(inbox.refresh({ ingestNative: true })).resolves.toEqual([draft("share-stable")]);
    expect(buildDraft).not.toHaveBeenCalled();
    expect(cleanupReplayedPayloads).toHaveBeenCalledWith([PAYLOAD]);
  });

  it("serializes concurrent refreshes so one native payload creates one inbox item", async () => {
    const building = deferred();
    const buildDraft = vi.fn(async ({ id, createdAt }) => {
      await building.promise;
      return { draft: draft(id, createdAt), cleanup: async () => undefined };
    });
    const { inbox } = createHarness({ buildDraft });

    const first = inbox.refresh({ ingestNative: true });
    const second = inbox.refresh({ ingestNative: true });
    building.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      [draft("share-stable")],
      [draft("share-stable")],
    ]);
    expect(buildDraft).toHaveBeenCalledTimes(1);
  });

  it("orders consumption after an in-flight refresh without restoring stale state", async () => {
    const building = deferred();
    const { inbox, persisted } = createHarness({
      buildDraft: async ({ id, createdAt }) => {
        await building.promise;
        return { draft: draft(id, createdAt), cleanup: async () => undefined };
      },
    });

    const refresh = inbox.refresh({ ingestNative: true });
    const consume = inbox.consume("share-stable");
    building.resolve();

    await expect(refresh).resolves.toEqual([draft("share-stable")]);
    await expect(consume).resolves.toEqual([]);
    expect([...persisted.values()]).toEqual([]);
  });

  it("consumes duplicate records left by a replay from the legacy random-id inbox", async () => {
    const { inbox, persisted } = createHarness();
    persisted.set("legacy-first", draft("legacy-first", "2026-07-16T07:59:00.000Z"));
    persisted.set("legacy-second", draft("legacy-second"));

    await expect(inbox.refresh({ ingestNative: false })).resolves.toEqual([
      draft("legacy-second"),
      draft("legacy-first", "2026-07-16T07:59:00.000Z"),
    ]);
    await expect(inbox.consume("legacy-second")).resolves.toEqual([]);
    expect([...persisted.values()]).toEqual([]);
  });

  it("keeps content-identical shares addressable by their own ids", async () => {
    const { inbox, persisted } = createHarness();
    persisted.set("share-open-flow", draft("share-open-flow", "2026-07-16T07:59:00.000Z"));
    persisted.set("share-newer", draft("share-newer"));

    await expect(inbox.refresh({ ingestNative: false })).resolves.toEqual([
      draft("share-newer"),
      draft("share-open-flow", "2026-07-16T07:59:00.000Z"),
    ]);
  });

  it("does not acknowledge a supported payload when its durable write fails", async () => {
    const clearPayloads = vi.fn();
    const cleanup = vi.fn(async () => undefined);
    const { inbox } = createHarness({
      clearPayloads,
      buildDraft: async ({ id, createdAt }) => ({
        draft: draft(id, createdAt),
        cleanup,
      }),
      writeDraft: async () => {
        throw new Error("disk full");
      },
    });

    await expect(inbox.refresh({ ingestNative: true })).rejects.toThrow("disk full");
    expect(clearPayloads).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });
});
