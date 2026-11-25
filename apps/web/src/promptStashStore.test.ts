import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";

import { removeLocalStorageItem } from "./hooks/useLocalStorage";
import { createMemoryStorage } from "./lib/storage";

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

function resetPromptStashStore() {
  usePromptStashStore.setState({ entries: [] });
  writePromptStashStorageForTest("");
  removeLocalStorageItem(PROMPT_STASH_STORAGE_KEY);
}

function notifyStorage(
  target: EventTarget,
  storageArea: ReturnType<typeof createMemoryStorage>,
  key: string | null = PROMPT_STASH_STORAGE_KEY,
  newValue?: string,
) {
  target.dispatchEvent(Object.assign(new Event("storage"), { key, storageArea, newValue }));
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
    store.stashEntry(makeEntry({ id: "stashed-while-encoding" }));
    expect(
      usePromptStashStore.getState().entries.find((entry) => entry.id === "pending-restore")
        ?.pendingImageCount,
    ).toBe(1);

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
    store.takeEntry("racing", "delete");

    const { attached } = store.finalizeEntryImages("racing", {
      attachments: [],
      droppedImageNames: [],
      unreadableImageNames: [],
    });

    expect(attached).toBe(false);
  });

  it("settles a pending count left behind by a crashed or closed session", () => {
    writePromptStashStorageForTest(
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
    expect(usePromptStashStore.getState().takeEntry("orphan").entry).toEqual(entry);
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

  // regression: #35010 stashing in one tab erased what another tab stashed after it loaded
  it("keeps an entry another tab stashed after this tab loaded", async () => {
    const sharedStorage = createMemoryStorage();
    vi.stubGlobal("localStorage", sharedStorage);
    const reader = new EventTarget();
    const writer = new EventTarget();
    vi.stubGlobal("window", reader);
    vi.resetModules();
    try {
      const thisTab = await import("./promptStashStore");
      sharedStorage.setItem(
        PROMPT_STASH_STORAGE_KEY,
        JSON.stringify({ version: 2, state: { entries: [makeEntry({ id: "other-tab" })] } }),
      );
      notifyStorage(reader, sharedStorage, "another-key");
      notifyStorage(reader, createMemoryStorage());
      expect(thisTab.usePromptStashStore.getState().entries).toEqual([]);
      notifyStorage(reader, sharedStorage, PROMPT_STASH_STORAGE_KEY, '{"state":{"entries":[]}}');
      expect(thisTab.usePromptStashStore.getState().entries.map((entry) => entry.id)).toEqual([
        "other-tab",
      ]);

      thisTab.usePromptStashStore.getState().stashEntry(makeEntry({ id: "this-tab" }));

      const saved = JSON.parse(sharedStorage.getItem(PROMPT_STASH_STORAGE_KEY) as string);
      expect(saved.state.entries.map((entry: PromptStashEntry) => entry.id)).toEqual([
        "this-tab",
        "other-tab",
      ]);

      thisTab.usePromptStashStore.getState().stashEntry({
        ...makeEntry({ id: "encoding-image" }),
        pendingImageCount: 1,
      });
      vi.stubGlobal("window", writer);
      vi.resetModules();
      const secondTab = await import("./promptStashStore");
      secondTab.usePromptStashStore.getState().stashEntry(makeEntry({ id: "while-encoding" }));
      notifyStorage(reader, sharedStorage);
      expect(thisTab.usePromptStashStore.getState().entries).toMatchObject([
        { id: "while-encoding" },
        { id: "encoding-image", pendingImageCount: 1 },
        { id: "this-tab" },
        { id: "other-tab" },
      ]);

      const finalized = makeEntry({ id: "encoding-image", attachmentChars: 12 }).attachments;
      thisTab.usePromptStashStore.getState().finalizeEntryImages("encoding-image", {
        attachments: finalized,
        droppedImageNames: [],
        unreadableImageNames: [],
      });
      notifyStorage(writer, sharedStorage);
      expect(
        secondTab.usePromptStashStore
          .getState()
          .entries.find((entry) => entry.id === "encoding-image")?.attachments,
      ).toEqual(finalized);
      secondTab.usePromptStashStore.getState().stashEntry(makeEntry({ id: "second-tab-new" }));
      const afterFinalization = JSON.parse(
        sharedStorage.getItem(PROMPT_STASH_STORAGE_KEY) as string,
      );
      expect(
        afterFinalization.state.entries.find(
          (entry: PromptStashEntry) => entry.id === "encoding-image",
        )?.attachments,
      ).toEqual(finalized);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it("keeps images pending in an open tab until the other tab finishes saving them", async () => {
    const storage = createMemoryStorage();
    const readerWindow = new EventTarget();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", readerWindow);
    vi.resetModules();
    try {
      const { usePromptStashStore: reader } = await import("./promptStashStore");
      vi.stubGlobal("window", new EventTarget());
      vi.resetModules();
      const { usePromptStashStore: writer } = await import("./promptStashStore");
      const entry = makeEntry({ id: "encoding-in-other-tab" });
      writer.getState().stashEntry({ ...entry, pendingImageCount: 1 });
      expect(reader.getState().takeEntry(entry.id).entry).toBeNull();
      notifyStorage(readerWindow, storage);

      expect(reader.getState().entries).toEqual([{ ...entry, pendingImageCount: 1 }]);

      vi.stubGlobal("window", new EventTarget());
      vi.resetModules();
      const { usePromptStashStore: reloaded } = await import("./promptStashStore");
      expect(reloaded.getState().entries[0]).toMatchObject({
        pendingImageCount: 0,
        unreadableImageNames: ["image 1 (not saved before reload)"],
      });
      reloaded.getState().stashEntry(makeEntry({ id: "unrelated" }));
      notifyStorage(readerWindow, storage);
      expect(reader.getState().entries[1]).toEqual({ ...entry, pendingImageCount: 1 });

      const { attachments } = makeEntry({ id: entry.id, attachmentChars: 12 });
      const images = { attachments, droppedImageNames: [], unreadableImageNames: [] };
      expect(writer.getState().finalizeEntryImages(entry.id, images)).toEqual({
        attached: true,
        durable: true,
      });
      notifyStorage(readerWindow, storage);
      const finalizedEntry = { ...entry, ...images, pendingImageCount: 0 };
      expect(reader.getState().entries[1]).toEqual(finalizedEntry);
      expect(reader.getState().takeEntry(entry.id).entry).toEqual(finalizedEntry);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it("lets open tabs restore an entry whose encoding tab closed mid-encode", async () => {
    const storage = createMemoryStorage();
    const readerWindow = new EventTarget();
    const writerWindow = new EventTarget();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", readerWindow);
    vi.resetModules();
    try {
      const { usePromptStashStore: reader } = await import("./promptStashStore");
      vi.stubGlobal("window", writerWindow);
      vi.resetModules();
      const { usePromptStashStore: writer } = await import("./promptStashStore");
      const entry = makeEntry({ id: "closed-mid-encode" });
      writer.getState().stashEntry({ ...entry, pendingImageCount: 1 });
      writer.getState().stashEntry(makeEntry({ id: "settled" }));

      writerWindow.dispatchEvent(new Event("pagehide"));
      notifyStorage(readerWindow, storage);

      expect(reader.getState().takeEntry(entry.id).entry).toMatchObject({
        pendingImageCount: 0,
        unreadableImageNames: ["image 1 (not saved before reload)"],
      });
      expect(reader.getState().entries.map((candidate) => candidate.id)).toEqual(["settled"]);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it.each([PROMPT_STASH_STORAGE_KEY, null])(
    "empties the stash when another tab removes its storage (event key %s)",
    async (key) => {
      const storage = createMemoryStorage();
      vi.stubGlobal("localStorage", storage);
      const reader = new EventTarget();
      vi.stubGlobal("window", reader);
      vi.resetModules();
      try {
        const { usePromptStashStore: store } = await import("./promptStashStore");
        store.getState().stashEntry(makeEntry({ id: "stored" }));

        storage.setItem(PROMPT_STASH_STORAGE_KEY, "{");
        notifyStorage(reader, storage);
        expect(store.getState().entries.map((entry) => entry.id)).toEqual(["stored"]);

        storage.removeItem(PROMPT_STASH_STORAGE_KEY);
        notifyStorage(reader, storage, key);
        expect(store.getState().entries).toEqual([]);
      } finally {
        vi.unstubAllGlobals();
        vi.resetModules();
      }
    },
  );

  it.each(["restore", "take"] as const)(
    "keeps a failed finalize after another tab stashes, then handles %s",
    async (action) => {
      const storage = createMemoryStorage();
      const sharedStorage = {
        ...storage,
        setItem: (key: string, value: string) => {
          if (value.includes("rejected-image")) throw new Error("QuotaExceededError");
          storage.setItem(key, value);
        },
      };
      vi.stubGlobal("localStorage", sharedStorage);
      const reader = new EventTarget();
      vi.stubGlobal("window", reader);
      vi.resetModules();
      try {
        const { usePromptStashStore: store } = await import("./promptStashStore");
        store.getState().stashEntry({ ...makeEntry({ id: "too-big" }), pendingImageCount: 1 });
        vi.stubGlobal("window", new EventTarget());
        vi.resetModules();
        const { usePromptStashStore: otherTab } = await import("./promptStashStore");
        const { attachments } = makeEntry({ id: "rejected-image", attachmentChars: 4 });
        const images = { attachments, droppedImageNames: [], unreadableImageNames: [] };
        expect(store.getState().finalizeEntryImages("too-big", images)).toEqual({
          attached: true,
          durable: false,
        });
        otherTab.getState().stashEntry(makeEntry({ id: "unrelated" }));
        notifyStorage(reader, sharedStorage);
        expect(store.getState().entries).toMatchObject([{ id: "unrelated" }, { attachments }]);

        if (action === "take") {
          otherTab.getState().takeEntry("too-big");
          notifyStorage(reader, sharedStorage);
          expect(store.getState().entries.map((entry) => entry.id)).toEqual(["unrelated"]);
          expect(store.getState().finalizeEntryImages("too-big", images)).toEqual({
            attached: false,
            durable: true,
          });
          expect(store.getState().takeEntry("too-big").entry).toBeNull();
          return;
        }

        expect(store.getState().takeEntry("too-big").entry).toMatchObject({
          attachments,
          unreadableImageNames: [],
        });
      } finally {
        vi.unstubAllGlobals();
        vi.resetModules();
      }
    },
  );
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
