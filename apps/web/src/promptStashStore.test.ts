import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { removeLocalStorageItem } from "./hooks/useLocalStorage";

import {
  MAX_STASH_ENTRIES,
  PROMPT_STASH_STORAGE_KEY,
  usePromptStashStore,
  writePromptStashStorageForTest,
  type PromptStashEntry,
} from "./promptStashStore";

function makeEntry(input: {
  id: string;
  prompt?: string;
  withAttachment?: boolean;
}): PromptStashEntry {
  return {
    id: input.id,
    createdAt: "2026-07-24T12:00:00.000Z",
    prompt: input.prompt ?? `prompt ${input.id}`,
    attachments: input.withAttachment
      ? [
          {
            id: `img-${input.id}`,
            attachmentId: `pending-${input.id}`,
            name: "shot.png",
            mimeType: "image/png",
            sizeBytes: 1024,
            environmentId: "env-1",
          },
        ]
      : [],
    droppedImageNames: [],
  };
}

function resetPromptStashStore() {
  usePromptStashStore.setState({ entries: [] });
  writePromptStashStorageForTest("");
  removeLocalStorageItem(PROMPT_STASH_STORAGE_KEY);
}

describe("promptStashStore", () => {
  beforeEach(() => {
    resetPromptStashStore();
  });

  afterEach(() => {
    resetPromptStashStore();
  });

  it("prepends entries so the newest stash is first", () => {
    const store = usePromptStashStore.getState();
    store.stashEntry(makeEntry({ id: "first" }));
    store.stashEntry(makeEntry({ id: "second" }));
    const entries = usePromptStashStore.getState().entries;
    expect(entries.map((entry) => entry.id)).toEqual(["second", "first"]);
  });

  it("evicts the oldest entry past the cap and returns it", () => {
    const store = usePromptStashStore.getState();
    for (let index = 0; index < MAX_STASH_ENTRIES; index += 1) {
      expect(store.stashEntry(makeEntry({ id: `entry-${index}` })).evicted).toBeNull();
    }
    const { evicted } = store.stashEntry(makeEntry({ id: "overflow" }));
    expect(evicted?.id).toBe("entry-0");
    const entries = usePromptStashStore.getState().entries;
    expect(entries).toHaveLength(MAX_STASH_ENTRIES);
    expect(entries[0]?.id).toBe("overflow");
  });

  // This test environment has no `localStorage`, so the store runs on its
  // in-memory fallback — the exact "kept for this session, gone on reload"
  // case the composer must distinguish from an outright write failure.
  it("distinguishes a memory-only write (written, not durable) from a failed one", () => {
    const store = usePromptStashStore.getState();
    const result = store.stashEntry(makeEntry({ id: "memory-only" }));
    expect(result.written).toBe(true);
    expect(result.durable).toBe(false);
    expect(usePromptStashStore.getState().entries.map((entry) => entry.id)).toEqual([
      "memory-only",
    ]);
  });

  it("takeEntry removes and returns the entry; second take returns null", () => {
    const store = usePromptStashStore.getState();
    store.stashEntry(makeEntry({ id: "keep" }));
    store.stashEntry(makeEntry({ id: "take" }));
    expect(store.takeEntry("take").entry?.id).toBe("take");
    expect(store.takeEntry("take").entry).toBeNull();
    const entries = usePromptStashStore.getState().entries;
    expect(entries.map((entry) => entry.id)).toEqual(["keep"]);
  });

  it("decodes a v3 payload with environment-scoped attachment references", () => {
    writePromptStashStorageForTest(
      JSON.stringify({
        version: 3,
        state: { entries: [makeEntry({ id: "restored", withAttachment: true })] },
      }),
    );

    const entry = usePromptStashStore.getState().entries[0];
    expect(entry?.id).toBe("restored");
    expect(entry?.attachments).toEqual([
      {
        id: "img-restored",
        attachmentId: "pending-restored",
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 1024,
        environmentId: "env-1",
      },
    ]);
  });

  it("ignores a v2 payload seeded under the current key", () => {
    // v2 stored each image inline as a data URL and has no `environmentId`,
    // so it cannot decode as v3; hydration must fall back to an empty stash
    // rather than throw.
    writePromptStashStorageForTest(
      JSON.stringify({
        version: 2,
        state: {
          entries: [
            {
              id: "legacy",
              createdAt: "2026-07-24T12:00:00.000Z",
              prompt: "legacy prompt",
              attachments: [
                {
                  id: "img-1",
                  name: "shot.png",
                  mimeType: "image/png",
                  sizeBytes: 10,
                  dataUrl: "data:image/png;base64,AAAA",
                },
              ],
              droppedImageNames: [],
            },
          ],
        },
      }),
    );
    expect(usePromptStashStore.getState().entries).toEqual([]);
  });
});
