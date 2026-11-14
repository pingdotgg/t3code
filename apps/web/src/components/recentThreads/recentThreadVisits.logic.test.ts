import { assert, describe, it } from "vite-plus/test";

import { RECENT_THREAD_LIMIT, recentThreadList } from "./recentThreadVisits.logic";

const candidates = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ key: `f${index}`, recentUse: index }));

describe("recentThreadList", () => {
  it("leaves out visited threads that are no longer visible", () => {
    const list = recentThreadList(["c", "b", "a"], new Set(["a", "c", "f0", "f1"]), candidates(2));
    assert.deepEqual(list.keys, ["c", "a", "f1", "f0"]);
    assert.strictEqual(list.ownCount, 2);
  });

  it("fills to the limit by recentUse without duplicating visits", () => {
    const fill = [{ key: "a", recentUse: 1000 }, ...candidates(12)];
    const visible = new Set(["a", "b", ...fill.map((candidate) => candidate.key)]);
    const list = recentThreadList(["b", "a"], visible, fill);
    assert.strictEqual(list.keys.length, RECENT_THREAD_LIMIT);
    assert.deepEqual(list.keys.slice(2), ["f11", "f10", "f9", "f8", "f7", "f6", "f5", "f4"]);
  });

  it("never cuts visits and adds no fill past the limit", () => {
    const visits = Array.from({ length: 11 }, (_, index) => `v${index}`);
    const visible = new Set([...visits, "f0"]);
    const list = recentThreadList(visits, visible, candidates(1));
    assert.deepEqual(list.keys, visits);
    assert.strictEqual(list.ownCount, 11);
  });
});
