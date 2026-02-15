import { assert, describe, it } from "vitest";
import { LruCache } from "./lru";

describe("LruCache", () => {
  it("evicts the least recently used entry", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    assert.strictEqual(cache.get("a"), 1);

    cache.set("c", 3);

    assert.strictEqual(cache.get("b"), undefined);
    assert.strictEqual(cache.get("a"), 1);
    assert.strictEqual(cache.get("c"), 3);
  });

  it("refreshes recency on update", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 10);
    cache.set("c", 3);

    assert.strictEqual(cache.get("b"), undefined);
    assert.strictEqual(cache.get("a"), 10);
    assert.strictEqual(cache.get("c"), 3);
  });

  it("rejects non-positive capacities", () => {
    assert.throws(() => new LruCache<string, number>(0), "positive integer");
  });
});
