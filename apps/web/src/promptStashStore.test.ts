import { ProviderInstanceId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  MAX_STASH_ENTRIES_PER_QUEUE,
  MAX_STASH_ENTRY_ATTACHMENT_CHARS,
  PROMPT_STASH_UNSCOPED_KEY,
  partitionStashAttachments,
  promptStashScopeKey,
  usePromptStashStore,
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
}

describe("promptStashScopeKey", () => {
  it("maps a provider instance to its own bucket and null to the unscoped bucket", () => {
    expect(promptStashScopeKey(CLAUDE_AGENT_INSTANCE)).toBe("claudeAgent");
    expect(promptStashScopeKey(null)).toBe(PROMPT_STASH_UNSCOPED_KEY);
    expect(promptStashScopeKey(undefined)).toBe(PROMPT_STASH_UNSCOPED_KEY);
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

  it("prepends entries so the newest stash is first", () => {
    const store = usePromptStashStore.getState();
    store.stashEntry(makeEntry({ id: "first" }));
    store.stashEntry(makeEntry({ id: "second" }));
    const queue = usePromptStashStore.getState().queuesByScopeKey["claudeAgent"] ?? [];
    expect(queue.map((entry) => entry.id)).toEqual(["second", "first"]);
  });

  it("scopes queues by provider instance, including the unscoped bucket", () => {
    const store = usePromptStashStore.getState();
    store.stashEntry(makeEntry({ id: "claude" }));
    store.stashEntry(makeEntry({ id: "codex", providerInstanceId: CODEX_INSTANCE }));
    store.stashEntry(makeEntry({ id: "none", providerInstanceId: null }));
    const queues = usePromptStashStore.getState().queuesByScopeKey;
    expect(queues["claudeAgent"]?.map((entry) => entry.id)).toEqual(["claude"]);
    expect(queues["codex"]?.map((entry) => entry.id)).toEqual(["codex"]);
    expect(queues[PROMPT_STASH_UNSCOPED_KEY]?.map((entry) => entry.id)).toEqual(["none"]);
  });

  it("evicts the oldest entry past the per-queue cap and returns it", () => {
    const store = usePromptStashStore.getState();
    for (let index = 0; index < MAX_STASH_ENTRIES_PER_QUEUE; index += 1) {
      expect(store.stashEntry(makeEntry({ id: `entry-${index}` }))).toBeNull();
    }
    const evicted = store.stashEntry(makeEntry({ id: "overflow" }));
    expect(evicted?.id).toBe("entry-0");
    const queue = usePromptStashStore.getState().queuesByScopeKey["claudeAgent"] ?? [];
    expect(queue).toHaveLength(MAX_STASH_ENTRIES_PER_QUEUE);
    expect(queue[0]?.id).toBe("overflow");
  });

  it("takeEntry removes and returns the entry; second take returns null", () => {
    const store = usePromptStashStore.getState();
    store.stashEntry(makeEntry({ id: "keep" }));
    store.stashEntry(makeEntry({ id: "take" }));
    expect(store.takeEntry("claudeAgent", "take")?.id).toBe("take");
    expect(store.takeEntry("claudeAgent", "take")).toBeNull();
    const queue = usePromptStashStore.getState().queuesByScopeKey["claudeAgent"] ?? [];
    expect(queue.map((entry) => entry.id)).toEqual(["keep"]);
  });

  it("drops the scope key entirely when its queue empties", () => {
    const store = usePromptStashStore.getState();
    store.stashEntry(makeEntry({ id: "only" }));
    store.takeEntry("claudeAgent", "only");
    expect(usePromptStashStore.getState().queuesByScopeKey["claudeAgent"]).toBeUndefined();
  });
});
