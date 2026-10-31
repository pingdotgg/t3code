import type { ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { reuseProvidersIgnoringCheckedAt } from "./serverProviders.logic";

const models = [{ slug: "opus", name: "Opus" }];
const provider = (instanceId: string, checkedAt: string, status = "ready") =>
  ({
    instanceId,
    status,
    checkedAt,
    models,
    versionAdvisory: { status: "current", checkedAt },
  }) as unknown as ServerProvider;

describe("reuseProvidersIgnoringCheckedAt", () => {
  it("keeps the previous list when a push only restamps checkedAt", () => {
    const previous = [provider("claude", "a"), provider("codex", "a")];
    const next = [provider("claude", "b"), provider("codex", "b")];
    expect(reuseProvidersIgnoringCheckedAt(previous, next)).toBe(previous);
  });

  it("takes the new list when providers are added or reordered", () => {
    const previous = [provider("claude", "a"), provider("codex", "a")];
    const reordered = [provider("codex", "b"), provider("claude", "b")];
    const merged = reuseProvidersIgnoringCheckedAt(previous, reordered);
    expect(merged.map((entry) => entry.instanceId)).toEqual(["codex", "claude"]);
    expect(merged[0]).toBe(previous[1]);
    const added = reuseProvidersIgnoringCheckedAt(previous, [...previous, provider("cursor", "b")]);
    expect(added).toHaveLength(3);
  });
});
