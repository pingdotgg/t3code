import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";

import { removeLocalStorageItem } from "./hooks/useLocalStorage";

import {
  MAX_STASH_ENTRIES,
  PROMPT_STASH_STORAGE_KEY,
  MAX_STASH_ENTRY_ATTACHMENT_CHARS,
  partitionStashAttachments,
  usePromptStashStore,
  writePromptStashStorageForTest,
  type PromptStashEntry,
} from "./promptStashStore";

function makeEntry(input: {
  id: string;
  prompt?: string;
  attachmentChars?: number;
}): PromptStashEntry {
  return {
    id: input.id,
    createdAt: "2026-07-24T12:00:00.000Z",
    prompt: input.prompt ?? `prompt ${input.id}`,
    attachments:
      input.attachmentChars !== undefined
        ? [
            {
              id: `${input.id}-img`,
              name: "shot.png",
              mimeType: "image/png",
              sizeBytes: input.attachmentChars,
              dataUrl: "x".repeat(input.attachmentChars),
            },
          ]
        : [],
    droppedImageNames: [],
  };
}

const encodedImage = {
  id: "img-encoded",
  name: "encoded.webp",
  mimeType: "image/webp",
  sizeBytes: 12,
  dataUrl: "data:image/webp;base64,BBBB",
};

/** A localStorage every tab imported after this call shares, as tabs of one origin do. */
function stubSharedStorage() {
  const shared = { stored: new Map<string, string>(), afterNextRead: null as (() => void) | null };
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => {
      const value = shared.stored.get(key) ?? null;
      const afterRead = shared.afterNextRead;
      shared.afterNextRead = null;
      afterRead?.();
      return value;
    },
    setItem: (key: string, value: string) => {
      shared.stored.set(key, value);
    },
    removeItem: (key: string) => {
      shared.stored.delete(key);
    },
  });
  return shared;
}

function stubLockManager() {
  const held = new Set<string>();
  type Granted = (lock: { name: string } | null) => unknown;
  vi.stubGlobal("navigator", {
    locks: {
      request: (name: string, ...args: [Granted] | [{ ifAvailable?: boolean }, Granted]) => {
        const [options, callback] = args.length === 1 ? [{}, args[0]] : args;
        // Grants at once or, with ifAvailable, reports the lock taken; never queues.
        if (held.has(name)) {
          if (options.ifAvailable) return Promise.resolve().then(() => callback(null));
          return Promise.reject(new Error(`fake LockManager cannot queue ${name}`));
        }
        held.add(name);
        return Promise.resolve()
          .then(() => callback({ name }))
          .finally(() => held.delete(name));
      },
    },
  });
}

async function importTab() {
  vi.resetModules();
  return await import("./promptStashStore");
}

function resetPromptStashStore() {
  usePromptStashStore.setState({ entries: [] });
  writePromptStashStorageForTest("");
  removeLocalStorageItem(PROMPT_STASH_STORAGE_KEY);
}

describe("partitionStashAttachments", () => {
  it("keeps attachments within the budget and reports dropped names in order", () => {
    const small = {
      id: "a",
      name: "small.png",
      mimeType: "image/png",
      sizeBytes: 10,
      dataUrl: "x".repeat(10),
    };
    const huge = {
      id: "b",
      name: "huge.png",
      mimeType: "image/png",
      sizeBytes: MAX_STASH_ENTRY_ATTACHMENT_CHARS,
      dataUrl: "x".repeat(MAX_STASH_ENTRY_ATTACHMENT_CHARS),
    };
    const alsoSmall = {
      id: "c",
      name: "also-small.png",
      mimeType: "image/png",
      sizeBytes: 10,
      dataUrl: "x".repeat(10),
    };
    const { kept, droppedNames } = partitionStashAttachments([small, huge, alsoSmall]);
    expect(kept.map((attachment) => attachment.id)).toEqual(["a", "c"]);
    expect(droppedNames).toEqual(["huge.png"]);
  });
});

describe("promptStashStore", () => {
  beforeEach(() => {
    resetPromptStashStore();
  });

  afterEach(() => {
    resetPromptStashStore();
  });

  it("restores citations and bound comments from a persisted stash", () => {
    const citation = {
      version: 1 as const,
      environmentId: EnvironmentId.make("remote-source"),
      threadId: ThreadId.make("source-thread"),
      messageId: MessageId.make("source-message"),
      text: "A quote to revisit later.",
      comment: "Revisit this tomorrow.\nCheck whether the example still applies.",
      start: 0,
      end: 24,
      prefix: "",
      suffix: " Next.",
    };
    const prompt = `Revisit ${serializeAssistantCitation(citation)}`;
    writePromptStashStorageForTest(
      JSON.stringify({
        version: 2,
        state: { entries: [makeEntry({ id: "citation-stash", prompt })] },
      }),
    );
    const restored = usePromptStashStore.getState().takeEntry("citation-stash").entry;
    expect(restored?.prompt).toBe(prompt);
    expect(
      collectAssistantCitations(restored?.prompt ?? "").map((entry) => entry.citation),
    ).toEqual([citation]);
    expect(usePromptStashStore.getState().takeEntry("citation-stash").entry).toBeNull();
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

  it("keeps an entry another tab stashed after this tab loaded", () => {
    writePromptStashStorageForTest(
      JSON.stringify({
        version: 2,
        state: { entries: [makeEntry({ id: "other-tab" })] },
      }),
    );
    // This tab loaded before the other tab's write, so its list is still empty.
    usePromptStashStore.setState({ entries: [] });

    usePromptStashStore.getState().stashEntry(makeEntry({ id: "this-tab" }));

    expect(usePromptStashStore.getState().entries.map((entry) => entry.id)).toEqual([
      "this-tab",
      "other-tab",
    ]);
  });

  // regression: #4787 stashed prompts were lost when switching providers
  it("distinguishes a memory-only write (written, not durable) from a failed one", () => {
    const store = usePromptStashStore.getState();
    const result = store.stashEntry(makeEntry({ id: "memory-only" }));
    expect(result.written).toBe(true);
    expect(result.durable).toBe(false);
    expect(usePromptStashStore.getState().entries.map((entry) => entry.id)).toEqual([
      "memory-only",
    ]);
  });

  it("takeEntry returns images and drop metadata finalized after a menu snapshot", () => {
    const store = usePromptStashStore.getState();
    store.stashEntry({ ...makeEntry({ id: "pending-restore" }), pendingImageCount: 1 });
    const menuSnapshot = usePromptStashStore.getState().entries[0];
    expect(menuSnapshot?.attachments).toEqual([]);

    store.finalizeEntryImages("pending-restore", {
      attachments: [
        {
          id: "img-finalized",
          name: "finalized.webp",
          mimeType: "image/webp",
          sizeBytes: 12,
          dataUrl: "data:image/webp;base64,BBBB",
        },
      ],
      droppedImageNames: ["too-large.png"],
      unreadableImageNames: ["unreadable.png"],
    });

    const { entry: taken } = store.takeEntry("pending-restore");
    expect(taken).not.toBe(menuSnapshot);
    expect(taken).toMatchObject({
      attachments: [
        {
          id: "img-finalized",
          name: "finalized.webp",
        },
      ],
      droppedImageNames: ["too-large.png"],
      unreadableImageNames: ["unreadable.png"],
      pendingImageCount: 0,
    });
  });

  it("preserves uploaded file references without storing file contents", () => {
    const store = usePromptStashStore.getState();
    const file = {
      id: "file-1",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      attachmentId: "pending-report-pdf",
      environmentId: EnvironmentId.make("environment-1"),
    };

    writePromptStashStorageForTest(
      JSON.stringify({
        version: 2,
        state: { entries: [{ ...makeEntry({ id: "with-file" }), files: [file] }] },
      }),
    );
    store.finalizeEntryImages("with-file", {
      attachments: [],
      droppedImageNames: [],
      unreadableImageNames: [],
    });

    expect(usePromptStashStore.getState().entries[0]?.files).toEqual([file]);
  });

  it("finalizeEntryImages reports false when the entry was already taken", () => {
    const store = usePromptStashStore.getState();
    store.stashEntry({ ...makeEntry({ id: "racing" }), pendingImageCount: 1 });
    store.takeEntry("racing");

    const { attached } = store.finalizeEntryImages("racing", {
      attachments: [],
      droppedImageNames: [],
      unreadableImageNames: [],
    });

    expect(attached).toBe(false);
  });

  it("settles a pending count left behind by a crashed or closed session", async () => {
    stubLockManager();
    try {
      await writePromptStashStorageForTest(
        JSON.stringify({
          version: 2,
          state: {
            entries: [{ ...makeEntry({ id: "orphan" }), pendingImageCount: 2 }],
          },
        }),
      );

      const entry = usePromptStashStore.getState().entries[0];
      expect(entry?.pendingImageCount).toBe(0);
      expect(entry?.unreadableImageNames).toHaveLength(2);

      usePromptStashStore.getState().stashEntry(makeEntry({ id: "later" }));
      expect(usePromptStashStore.getState().entries[1]).toEqual(entry);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps an entry pending however old while the tab encoding it is alive", async () => {
    const shared = stubSharedStorage();
    stubLockManager();
    try {
      const encodingTab = (await importTab()).usePromptStashStore;
      const loadingTab = await importTab();
      // A suspended tab can resume its encode long after it stashed.
      encodingTab.getState().stashEntry({
        ...makeEntry({ id: "suspended" }),
        createdAt: "2000-01-01T00:00:00.000Z",
        pendingImageCount: 1,
      });

      await loadingTab.writePromptStashStorageForTest(
        shared.stored.get(PROMPT_STASH_STORAGE_KEY) ?? "",
      );
      expect(loadingTab.usePromptStashStore.getState().entries[0]?.pendingImageCount).toBe(1);

      expect(
        encodingTab.getState().finalizeEntryImages("suspended", {
          attachments: [encodedImage],
          droppedImageNames: [],
          unreadableImageNames: [],
        }).attached,
      ).toBe(true);
      expect(loadingTab.usePromptStashStore.getState().takeEntry("suspended").entry).toMatchObject({
        attachments: [encodedImage],
        unreadableImageNames: [],
        pendingImageCount: 0,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("settling an orphan keeps images another tab finalized meanwhile", async () => {
    const shared = stubSharedStorage();
    stubLockManager();
    try {
      const tab = await importTab();
      const orphan = { ...makeEntry({ id: "orphan" }), pendingImageCount: 1 };
      const encoding = { ...makeEntry({ id: "encoding" }), pendingImageCount: 1 };
      shared.afterNextRead = () => {
        shared.stored.set(
          PROMPT_STASH_STORAGE_KEY,
          JSON.stringify({
            version: 2,
            state: {
              entries: [orphan, { ...encoding, attachments: [encodedImage], pendingImageCount: 0 }],
            },
          }),
        );
      };

      await tab.writePromptStashStorageForTest(
        JSON.stringify({ version: 2, state: { entries: [orphan, encoding] } }),
      );

      expect(JSON.parse(shared.stored.get(PROMPT_STASH_STORAGE_KEY) ?? "null")).toMatchObject({
        state: {
          entries: [
            { id: "orphan", pendingImageCount: 1 },
            { id: "encoding", attachments: [encodedImage], pendingImageCount: 0 },
          ],
        },
      });
      expect(tab.usePromptStashStore.getState().takeEntry("encoding").entry?.attachments).toEqual([
        encodedImage,
      ]);

      const settling = tab.writePromptStashStorageForTest(
        JSON.stringify({ version: 2, state: { entries: [orphan] } }),
      );
      shared.afterNextRead = () => {
        tab.usePromptStashStore.getState().stashEntry(makeEntry({ id: "new-text" }));
      };
      await settling;
      expect(tab.usePromptStashStore.getState().takeEntry("new-text").entry?.prompt).toBe(
        "prompt new-text",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("settling waits out a live encode so its finalize keeps the images", async () => {
    const shared = stubSharedStorage();
    stubLockManager();
    try {
      const encodingTab = (await importTab()).usePromptStashStore;
      const loadingTab = await importTab();
      const orphan = { ...makeEntry({ id: "orphan" }), pendingImageCount: 1 };
      shared.stored.set(
        PROMPT_STASH_STORAGE_KEY,
        JSON.stringify({ version: 2, state: { entries: [orphan] } }),
      );
      encodingTab.getState().stashEntry({ ...makeEntry({ id: "encoding" }), pendingImageCount: 1 });
      const stashed = shared.stored.get(PROMPT_STASH_STORAGE_KEY) ?? "";

      let finalized: { attached: boolean } | undefined;
      const settling = loadingTab.writePromptStashStorageForTest(stashed);
      // Fires the encode after settlement has returned, as a finishing tab's finalize can.
      shared.afterNextRead = () => {
        finalized = encodingTab.getState().finalizeEntryImages("encoding", {
          attachments: [encodedImage],
          droppedImageNames: [],
          unreadableImageNames: [],
        });
      };
      await settling;
      // Fires the finalize now if settlement never read storage again.
      localStorage.getItem(PROMPT_STASH_STORAGE_KEY);

      expect(finalized?.attached).toBe(true);
      expect(JSON.parse(shared.stored.get(PROMPT_STASH_STORAGE_KEY) ?? "null")).toMatchObject({
        state: {
          entries: [
            { id: "encoding", attachments: [encodedImage], pendingImageCount: 0 },
            { id: "orphan", pendingImageCount: 1 },
          ],
        },
      });
      expect(loadingTab.usePromptStashStore.getState().takeEntry("encoding").entry).toMatchObject({
        attachments: [encodedImage],
        pendingImageCount: 0,
      });

      await loadingTab.writePromptStashStorageForTest(
        shared.stored.get(PROMPT_STASH_STORAGE_KEY) ?? "",
      );
      expect(loadingTab.usePromptStashStore.getState().entries).toMatchObject([
        { id: "orphan", pendingImageCount: 0, unreadableImageNames: [expect.any(String)] },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("settling keeps images of an entry stashed while it acquired locks", async () => {
    const shared = stubSharedStorage();
    stubLockManager();
    try {
      const encodingTab = (await importTab()).usePromptStashStore;
      const loadingTab = await importTab();
      const orphan = { ...makeEntry({ id: "orphan" }), pendingImageCount: 1 };

      const settling = loadingTab.writePromptStashStorageForTest(
        JSON.stringify({ version: 2, state: { entries: [orphan] } }),
      );
      encodingTab.getState().stashEntry({ ...makeEntry({ id: "late" }), pendingImageCount: 1 });
      let finalized: { attached: boolean } | undefined;
      shared.afterNextRead = () => {
        finalized = encodingTab.getState().finalizeEntryImages("late", {
          attachments: [encodedImage],
          droppedImageNames: [],
          unreadableImageNames: [],
        });
      };
      await settling;

      expect(finalized?.attached).toBe(true);
      expect(JSON.parse(shared.stored.get(PROMPT_STASH_STORAGE_KEY) ?? "null")).toMatchObject({
        state: {
          entries: [
            { id: "late", attachments: [encodedImage], pendingImageCount: 0 },
            { id: "orphan" },
          ],
        },
      });
      expect(loadingTab.usePromptStashStore.getState().takeEntry("late").entry).toMatchObject({
        attachments: [encodedImage],
        pendingImageCount: 0,
      });

      await loadingTab.writePromptStashStorageForTest(
        shared.stored.get(PROMPT_STASH_STORAGE_KEY) ?? "",
      );
      expect(loadingTab.usePromptStashStore.getState().entries).toMatchObject([
        { id: "orphan", pendingImageCount: 0, unreadableImageNames: [expect.any(String)] },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the pending count of an entry another tab may still be encoding", async () => {
    // Without Web Locks the age window decides; a far-future createdAt is inside it, clock unread.
    vi.stubGlobal("navigator", {});
    const encoding = {
      ...makeEntry({ id: "encoding" }),
      createdAt: "9999-01-01T00:00:00.000Z",
      pendingImageCount: 1,
    };
    await writePromptStashStorageForTest(
      JSON.stringify({ version: 2, state: { entries: [encoding] } }),
    );
    try {
      expect(usePromptStashStore.getState().entries).toEqual([encoding]);

      // Storage still holds the pending entry, not a settled copy.
      const store = usePromptStashStore.getState();
      store.stashEntry(makeEntry({ id: "later" }));
      expect(usePromptStashStore.getState().entries[1]).toEqual(encoding);

      const image = {
        id: "img-encoded",
        name: "encoded.webp",
        mimeType: "image/webp",
        sizeBytes: 12,
        dataUrl: "data:image/webp;base64,BBBB",
      };
      expect(
        store.finalizeEntryImages("encoding", {
          attachments: [image],
          droppedImageNames: [],
          unreadableImageNames: [],
        }).attached,
      ).toBe(true);
      expect(store.takeEntry("encoding").entry).toMatchObject({
        attachments: [image],
        unreadableImageNames: [],
        pendingImageCount: 0,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps images storage rejected for this session and settles the stored entry", async () => {
    // A localStorage that rejects large writes, as a full origin quota does.
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (value.length > 2_000) {
          throw new DOMException("Quota exceeded", "QuotaExceededError");
        }
        stored.set(key, value);
      },
      removeItem: (key: string) => {
        stored.delete(key);
      },
    });
    vi.resetModules();
    try {
      const { usePromptStashStore: store } = await import("./promptStashStore");
      const { stashEntry, finalizeEntryImages, takeEntry } = store.getState();
      const bigImage = {
        id: "big-img",
        name: "big.png",
        mimeType: "image/png",
        sizeBytes: 5_000,
        dataUrl: "x".repeat(5_000),
      };
      const rejectedImages = {
        attachments: [bigImage],
        droppedImageNames: [],
        unreadableImageNames: [],
      };

      stashEntry({ ...makeEntry({ id: "rejected" }), pendingImageCount: 1 });
      expect(finalizeEntryImages("rejected", rejectedImages)).toEqual({
        attached: true,
        durable: false,
      });

      // After a reload, and in other tabs, the entry reports the image missing.
      expect(JSON.parse(stored.get(PROMPT_STASH_STORAGE_KEY) ?? "null")).toMatchObject({
        state: {
          entries: [
            {
              id: "rejected",
              attachments: [],
              droppedImageNames: ["big.png"],
              pendingImageCount: 0,
            },
          ],
        },
      });

      // A later write re-reads storage, yet this tab still holds the image.
      stashEntry(makeEntry({ id: "later" }));
      expect(store.getState().entries[1]).toMatchObject({
        id: "rejected",
        attachments: [{ name: "big.png" }],
        pendingImageCount: 0,
      });
      expect(takeEntry("rejected").entry?.attachments).toEqual([bigImage]);

      // An entry another tab already restored stays gone.
      stashEntry({ ...makeEntry({ id: "restored-elsewhere" }), pendingImageCount: 1 });
      finalizeEntryImages("restored-elsewhere", rejectedImages);
      stored.set(
        PROMPT_STASH_STORAGE_KEY,
        JSON.stringify({ version: 2, state: { entries: [makeEntry({ id: "later" })] } }),
      );
      expect(takeEntry("restored-elsewhere").entry).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ignores an unreadable v1 payload seeded under the current key", () => {
    writePromptStashStorageForTest(
      JSON.stringify({
        version: 1,
        state: { queuesByScopeKey: { "provider:claudeAgent": [] } },
      }),
    );
    expect(usePromptStashStore.getState().entries).toEqual([]);
  });
});

describe("prompt stash context records", () => {
  it("restores the records behind a persisted prompt's chips", () => {
    const records = [
      {
        version: 1 as const,
        contextId: "ctx-1" as never,
        kind: "terminal" as const,
        label: "Terminal 1 line 4",
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "boom",
      },
    ];
    writePromptStashStorageForTest(
      JSON.stringify({
        version: 2,
        state: {
          entries: [
            {
              id: "entry-records",
              createdAt: "2026-01-01T00:00:00.000Z",
              prompt: "see [Terminal 1 line 4](t3-context://v1/terminal/ctx-1)",
              attachments: [],
              droppedImageNames: [],
              records,
            },
          ],
        },
      }),
    );
    const taken = usePromptStashStore.getState().takeEntry("entry-records");
    expect(taken.entry?.records).toEqual(records);
  });
});
