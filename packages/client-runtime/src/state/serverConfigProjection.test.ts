import type { ServerConfig, ServerConfigStreamEvent } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { applyServerConfigProjection, reuseUnchanged } from "./serverConfigProjection.ts";

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

describe("applyServerConfigProjection snapshot", () => {
  const snapshot = (checkedAt: string) =>
    ({
      type: "snapshot",
      config: {
        environment: { capabilities: {} },
        providers: [{ instanceId: "claude", checkedAt, skills: [{ name: "review" }] }],
      },
    }) as unknown as ServerConfigStreamEvent;
  const providersOf = (projection: ReturnType<typeof applyServerConfigProjection>) =>
    (Option.getOrThrow(projection).config as ServerConfig).providers;

  it("keeps unchanged skills when a reconnect re-sends the config", () => {
    const first = applyServerConfigProjection(Option.none(), snapshot("a"));
    const second = applyServerConfigProjection(first, snapshot("b"));
    expect(providersOf(second)[0]!.checkedAt).toBe("b");
    expect(providersOf(second)[0]!.skills).toBe(providersOf(first)[0]!.skills);
  });
});
