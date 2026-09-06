import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  createMemoryComposerImageBlobStore,
  getComposerImageBlobStore,
  setComposerImageBlobStoreForTests,
} from "./composerImageBlobStore";

afterEach(() => {
  setComposerImageBlobStoreForTests(null);
});

describe("createMemoryComposerImageBlobStore", () => {
  it("roundtrips put/get bytes", async () => {
    const store = createMemoryComposerImageBlobStore();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await store.put("img-1", new Blob([bytes], { type: "image/png" }));

    const stored = await store.get("img-1");
    expect(stored).toBeInstanceOf(Blob);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes);
  });

  it("returns undefined for a missing key", async () => {
    const store = createMemoryComposerImageBlobStore();
    expect(await store.get("missing")).toBeUndefined();
  });

  it("deletes a stored blob", async () => {
    const store = createMemoryComposerImageBlobStore();
    await store.put("img-1", new Blob([new Uint8Array([9])]));
    await store.delete("img-1");
    expect(await store.get("img-1")).toBeUndefined();
  });

  it("deleteAllExcept keeps listed ids and drops others", async () => {
    const store = createMemoryComposerImageBlobStore();
    await store.put("keep-a", new Blob([new Uint8Array([1])]));
    await store.put("drop-b", new Blob([new Uint8Array([2])]));
    await store.put("keep-c", new Blob([new Uint8Array([3])]));

    await store.deleteAllExcept(new Set(["keep-a", "keep-c"]));

    expect(await store.get("keep-a")).toBeInstanceOf(Blob);
    expect(await store.get("keep-c")).toBeInstanceOf(Blob);
    expect(await store.get("drop-b")).toBeUndefined();
  });

  it("does not share state across instances", async () => {
    const first = createMemoryComposerImageBlobStore();
    const second = createMemoryComposerImageBlobStore();
    await first.put("img-1", new Blob([new Uint8Array([7])]));

    expect(await first.get("img-1")).toBeInstanceOf(Blob);
    expect(await second.get("img-1")).toBeUndefined();
  });
});

describe("getComposerImageBlobStore", () => {
  it("uses the store set by setComposerImageBlobStoreForTests", async () => {
    const store = createMemoryComposerImageBlobStore();
    setComposerImageBlobStoreForTests(store);
    expect(getComposerImageBlobStore()).toBe(store);

    setComposerImageBlobStoreForTests(null);
    expect(getComposerImageBlobStore()).not.toBe(store);
  });
});
