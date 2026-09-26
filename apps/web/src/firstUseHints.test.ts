import { describe, expect, it, vi } from "vite-plus/test";

import { createFirstUseHintManager, type FirstUseHint } from "./firstUseHints";

function memoryStorage(initial?: string): Storage {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set("t3code:first-use-hints:v1", initial);
  return {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

const hint = (id: string): FirstUseHint => ({ id, title: id, description: `${id} description` });

describe("first-use hints", () => {
  it("claims a hint before publishing it and never queues that id again", () => {
    const storage = memoryStorage();
    const manager = createFirstUseHintManager({ storage: () => storage });
    const listener = vi.fn();
    manager.subscribe(listener);

    expect(manager.show(hint("settle"))).toBe(true);
    expect(manager.getSnapshot().current?.id).toBe("settle");
    expect(manager.show(hint("settle"))).toBe(false);
    expect(listener).toHaveBeenCalledOnce();

    const persisted = JSON.parse(storage.getItem("t3code:first-use-hints:v1") ?? "null");
    expect(persisted).toEqual({ seen: ["settle"] });
  });

  it("serializes overlapping hints in the order they were claimed", () => {
    const manager = createFirstUseHintManager({ storage: () => memoryStorage() });
    manager.show(hint("first"));
    manager.show(hint("second"));

    expect(manager.getSnapshot().current?.id).toBe("first");
    manager.dismiss("not-current");
    expect(manager.getSnapshot().current?.id).toBe("first");
    manager.dismiss("first");
    expect(manager.getSnapshot().current?.id).toBe("second");
    manager.dismiss("second");
    expect(manager.getSnapshot().current).toBeNull();
  });

  it("honors claims made by an earlier manager", () => {
    const storage = memoryStorage();
    const first = createFirstUseHintManager({ storage: () => storage });
    const reloaded = createFirstUseHintManager({ storage: () => storage });

    expect(first.show(hint("settle"))).toBe(true);
    expect(reloaded.show(hint("settle"))).toBe(false);
    expect(reloaded.getSnapshot().current).toBeNull();
  });

  it("recovers from malformed storage without repeatedly showing in one session", () => {
    const storage = memoryStorage("not json");
    const manager = createFirstUseHintManager({ storage: () => storage });

    expect(manager.show(hint("settle"))).toBe(true);
    manager.dismiss("settle");
    expect(manager.show(hint("settle"))).toBe(false);
  });

  it("falls back to session deduplication when storage is unavailable", () => {
    const reportError = vi.fn();
    const manager = createFirstUseHintManager({
      storage: () => {
        throw new Error("blocked");
      },
      reportError,
    });

    expect(manager.show(hint("settle"))).toBe(true);
    manager.dismiss("settle");
    expect(manager.show(hint("settle"))).toBe(false);
    expect(reportError).toHaveBeenCalled();
  });
});
