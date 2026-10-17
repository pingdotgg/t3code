import { describe, expect, it } from "vite-plus/test";

import { reuseUnchanged } from "./serverConfigProjection.ts";

describe("reuseUnchanged", () => {
  const provider = (checkedAt: string, skills: ReadonlyArray<string>) => ({
    instanceId: "claude",
    checkedAt,
    models: [{ slug: "opus", name: "Opus" }],
    skills: skills.map((name) => ({ name })),
  });

  it("returns the previous value when nothing changed", () => {
    const previous = [provider("a", ["x"])];
    expect(reuseUnchanged(previous, [provider("a", ["x"])])).toBe(previous);
  });

  it("keeps unchanged parts when one field changes", () => {
    const previous = [provider("a", ["x"]), { ...provider("a", ["y"]), instanceId: "codex" }];
    const next = reuseUnchanged(previous, [
      provider("b", ["x"]),
      { ...provider("a", ["y"]), instanceId: "codex" },
    ]);
    expect(next).not.toBe(previous);
    expect(next[0]).not.toBe(previous[0]);
    expect(next[0]!.checkedAt).toBe("b");
    expect(next[0]!.models).toBe(previous[0]!.models);
    expect(next[0]!.skills).toBe(previous[0]!.skills);
    expect(next[1]).toBe(previous[1]);
  });

  it("takes the new value when keys or lengths change", () => {
    const previous = [provider("a", ["x"])];
    const next = reuseUnchanged(previous, [provider("a", ["x", "z"])]);
    expect(next[0]!.skills).toHaveLength(2);
    expect(next[0]!.models).toBe(previous[0]!.models);
    const dropped = reuseUnchanged({ a: 1, b: 2 }, { a: 1 });
    expect(dropped).toEqual({ a: 1 });
  });
});
