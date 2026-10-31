import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { applyServerSettingsPatch } from "./serverSettings.ts";

const mapping = (id: string) => ({
  id,
  kind: "team" as const,
  linearId: `team-${id}`,
  linearName: id,
  projectId: ProjectId.make(`project-${id}`),
});

describe("linear settings patch", () => {
  it("merges fields shallowly and replaces the mappings array", () => {
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      linear: { apiKey: "key", mappings: [mapping("a"), mapping("b")], commentEnabled: true },
    });
    const second = applyServerSettingsPatch(first, {
      linear: { mappings: [mapping("c")], moveToStateEnabled: true },
    });
    expect(second.linear.apiKey).toBe("key");
    expect(second.linear.commentEnabled).toBe(true);
    expect(second.linear.moveToStateEnabled).toBe(true);
    expect(second.linear.mappings.map((entry) => entry.id)).toEqual(["c"]);
  });

  it("leaves linear untouched when the patch omits it", () => {
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, { linear: { apiKey: "key" } });
    expect(applyServerSettingsPatch(first, {}).linear.apiKey).toBe("key");
  });
});
