import { ProviderInstanceId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { removeLocalStorageItem } from "./hooks/useLocalStorage";

import {
  MAX_STASH_ENTRIES_PER_QUEUE,
  PROMPT_STASH_STORAGE_KEY,
  MAX_STASH_ENTRY_ATTACHMENT_CHARS,
  PROMPT_STASH_UNSCOPED_KEY,
  partitionStashAttachments,
  promptStashScopeKey,
  usePromptStashStore,
  writePromptStashStorageForTest,
  type PromptStashEntry,
} from "./promptStashStore";

const CLAUDE_AGENT_INSTANCE = ProviderInstanceId.make("claudeAgent");
const CODEX_INSTANCE = ProviderInstanceId.make("codex");

function makeEntry(input: {
  id: string;
  providerInstanceId?: ProviderInstanceId | null;
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
    providerInstanceId:
      input.providerInstanceId === undefined ? CLAUDE_AGENT_INSTANCE : input.providerInstanceId,
    modelSelection: null,
    droppedImageNames: [],
  };
}

function resetPromptStashStore() {
  usePromptStashStore.setState({ queuesByScopeKey: {} });
  writePromptStashStorageForTest("");
  removeLocalStorageItem(PROMPT_STASH_STORAGE_KEY);
}

describe("promptStashScopeKey", () => {
  it("maps a provider instance to its own bucket and null to the unscoped bucket", () => {
    expect(promptStashScopeKey(CLAUDE_AGENT_INSTANCE)).toBe("provider:claudeAgent");
    expect(promptStashScopeKey(null)).toBe(PROMPT_STASH_UNSCOPED_KEY);
    expect(promptStashScopeKey(undefined)).toBe(PROMPT_STASH_UNSCOPED_KEY);
  });

  // Provider slugs must match /^[a-zA-Z][a-zA-Z0-9_-]*$/, so no real instance
  // id can equal the unscoped sentinel. The namespace prefix makes that
  // structural rather than incidental.
  it("namespaces provider keys so they can never equal the unscoped sentinel", () => {
    expect(promptStashScopeKey(CLAUDE_AGENT_INSTANCE)).not.toBe(PROMPT_STASH_UNSCOPED_KEY);
    expect(promptStashScopeKey(CODEX_INSTANCE).startsWith("provider:")).toBe(true);
  });
});

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

  it("admits a single attachment that exactly fits the budget", () => {
    const exact = {
      id: "a",
      name: "exact.png",
      mimeType: "image/png",
      sizeBytes: MAX_STASH_ENTRY_ATTACHMENT_CHARS,
      dataUrl: "x".repeat(MAX_STASH_ENTRY_ATTACHMENT_CHARS),
    };
    const { kept, droppedNames } = partitionStashAttachments([exact]);
    expect(kept).toHaveLength(1);
    expect(droppedNames).toEqual([]);
  });
});

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
    const queue =
      usePromptStashStore.getState().queuesByScopeKey[promptStashScopeKey(CLAUDE_AGENT_INSTANCE)] ??
      [];
    expect(queue.map((entry) => entry.id)).toEqual(["second", "first"]);
  });

  it("scopes queues by provider instance, including the unscoped bucket", () => {
    const store = usePromptStashStore.getState();
    store.stashEntry(makeEntry({ id: "claude" }));
    store.stashEntry(makeEntry({ id: "codex", providerInstanceId: CODEX_INSTANCE }));
    store.stashEntry(makeEntry({ id: "none", providerInstanceId: null }));
    const queues = usePromptStashStore.getState().queuesByScopeKey;
    expect(queues[promptStashScopeKey(CLAUDE_AGENT_INSTANCE)]?.map((entry) => entry.id)).toEqual([
      "claude",
    ]);
    expect(queues[promptStashScopeKey(CODEX_INSTANCE)]?.map((entry) => entry.id)).toEqual([
      "codex",
    ]);
    expect(queues[PROMPT_STASH_UNSCOPED_KEY]?.map((entry) => entry.id)).toEqual(["none"]);
  });

  it("evicts the oldest entry past the per-queue cap and returns it", () => {
    const store = usePromptStashStore.getState();
    for (let index = 0; index < MAX_STASH_ENTRIES_PER_QUEUE; index += 1) {
      expect(store.stashEntry(makeEntry({ id: `entry-${index}` })).evicted).toBeNull();
    }
    const { evicted } = store.stashEntry(makeEntry({ id: "overflow" }));
    expect(evicted?.id).toBe("entry-0");
    const queue =
      usePromptStashStore.getState().queuesByScopeKey[promptStashScopeKey(CLAUDE_AGENT_INSTANCE)] ??
      [];
    expect(queue).toHaveLength(MAX_STASH_ENTRIES_PER_QUEUE);
    expect(queue[0]?.id).toBe("overflow");
  });

  it("takeEntry removes and returns the entry; second take returns null", () => {
    const store = usePromptStashStore.getState();
    store.stashEntry(makeEntry({ id: "keep" }));
    store.stashEntry(makeEntry({ id: "take" }));
    expect(store.takeEntry(promptStashScopeKey(CLAUDE_AGENT_INSTANCE), "take").entry?.id).toBe(
      "take",
    );
    expect(store.takeEntry(promptStashScopeKey(CLAUDE_AGENT_INSTANCE), "take").entry).toBeNull();
    const queue =
      usePromptStashStore.getState().queuesByScopeKey[promptStashScopeKey(CLAUDE_AGENT_INSTANCE)] ??
      [];
    expect(queue.map((entry) => entry.id)).toEqual(["keep"]);
  });

  // Queue keys are persisted as plain strings, so a hand-edited or corrupted
  // localStorage payload can carry a literal `__proto__` key that survives
  // JSON.parse as an own property. An unguarded lookup would resolve to
  // Object.prototype and throw "not iterable" on spread.
  it("tolerates a __proto__ scope key rehydrated from storage", () => {
    usePromptStashStore.setState({
      queuesByScopeKey: JSON.parse('{"__proto__":[]}') as Record<string, PromptStashEntry[]>,
    });
    const store = usePromptStashStore.getState();
    expect(() => store.takeEntry("__proto__", "missing")).not.toThrow();
    expect(store.takeEntry("__proto__", "missing").entry).toBeNull();
  });

  it("finalizeEntryImages attaches images and clears the pending count", () => {
    const store = usePromptStashStore.getState();
    const scopeKey = promptStashScopeKey(CLAUDE_AGENT_INSTANCE);
    store.stashEntry({ ...makeEntry({ id: "pending" }), pendingImageCount: 2 });

    const { attached } = store.finalizeEntryImages(scopeKey, "pending", {
      attachments: [
        {
          id: "img-1",
          name: "a.webp",
          mimeType: "image/webp",
          sizeBytes: 10,
          dataUrl: "data:image/webp;base64,AAAA",
        },
      ],
      droppedImageNames: ["big.png"],
      unreadableImageNames: [],
    });

    expect(attached).toBe(true);
    const entry = usePromptStashStore.getState().queuesByScopeKey[scopeKey]?.[0];
    expect(entry?.attachments).toHaveLength(1);
    expect(entry?.droppedImageNames).toEqual(["big.png"]);
    expect(entry?.pendingImageCount).toBe(0);
  });

  it("finalizeEntryImages reports false when the entry was already taken", () => {
    const store = usePromptStashStore.getState();
    const scopeKey = promptStashScopeKey(CLAUDE_AGENT_INSTANCE);
    store.stashEntry({ ...makeEntry({ id: "racing" }), pendingImageCount: 1 });
    // Restored (or deleted) while its images were still encoding.
    store.takeEntry(scopeKey, "racing");

    const { attached } = store.finalizeEntryImages(scopeKey, "racing", {
      attachments: [],
      droppedImageNames: [],
      unreadableImageNames: [],
    });

    expect(attached).toBe(false);
  });

  it("settles a pending count left behind by a crashed or closed session", () => {
    const scopeKey = promptStashScopeKey(CLAUDE_AGENT_INSTANCE);
    writePromptStashStorageForTest(
      JSON.stringify({
        version: 1,
        state: {
          queuesByScopeKey: {
            [scopeKey]: [{ ...makeEntry({ id: "orphan" }), pendingImageCount: 2 }],
          },
        },
      }),
    );

    // Hydration must settle the stale count, or the entry would stay stuck
    // showing "saving…" with images that no longer exist anywhere.
    const entry = usePromptStashStore.getState().queuesByScopeKey[scopeKey]?.[0];
    expect(entry?.pendingImageCount).toBe(0);
    expect(entry?.unreadableImageNames).toHaveLength(2);
  });

  it("drops the scope key entirely when its queue empties", () => {
    const store = usePromptStashStore.getState();
    store.stashEntry(makeEntry({ id: "only" }));
    store.takeEntry(promptStashScopeKey(CLAUDE_AGENT_INSTANCE), "only");
    expect(
      usePromptStashStore.getState().queuesByScopeKey[promptStashScopeKey(CLAUDE_AGENT_INSTANCE)],
    ).toBeUndefined();
  });
});
