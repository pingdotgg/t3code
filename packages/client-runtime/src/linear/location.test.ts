import { describe, expect, it } from "vite-plus/test";

import {
  isStaleLocationForOrganization,
  linearListKey,
  parseStoredLinearLocation,
  serializeLinearLocation,
} from "./location.ts";

describe("stored Linear location", () => {
  it("round-trips a sanitised search", () => {
    const raw = serializeLinearLocation({
      organizationId: "org-1",
      search: { team: "t1", project: "p1", issue: "i1", states: ["s1"], showCompleted: true },
    });
    expect(parseStoredLinearLocation(raw)).toEqual({
      organizationId: "org-1",
      search: { team: "t1", project: "p1", issue: "i1", states: ["s1"], showCompleted: true },
    });
  });

  it("sanitises hand-edited storage", () => {
    const raw = JSON.stringify({
      organizationId: "org-1",
      search: { project: "orphan", group: "bogus", issue: "i9", evil: "x" },
    });
    expect(parseStoredLinearLocation(raw)?.search).toEqual({ issue: "i9" });
  });

  it.each([null, undefined, "", "not json", "[]", "null", `{"search":3}`, "x".repeat(9_000)])(
    "falls back for %j",
    (raw: string | null | undefined) => {
      expect(parseStoredLinearLocation(raw)).toBeNull();
    },
  );
});

describe("isStaleLocationForOrganization", () => {
  const stored = { organizationId: "org-1", search: { team: "t1" } };
  it("flags a search restored from another organization only", () => {
    expect(isStaleLocationForOrganization(stored, "org-2", { team: "t1" })).toBe(true);
    expect(isStaleLocationForOrganization(stored, "org-2", { team: "t9" })).toBe(false);
    expect(isStaleLocationForOrganization(stored, "org-1", { team: "t1" })).toBe(false);
    expect(isStaleLocationForOrganization(stored, null, { team: "t1" })).toBe(false);
    expect(isStaleLocationForOrganization(null, "org-2", { team: "t1" })).toBe(false);
  });
});

describe("linearListKey", () => {
  it("ignores the selected issue but not scope or filters", () => {
    expect(linearListKey({ team: "t1", issue: "a" })).toBe(
      linearListKey({ team: "t1", issue: "b" }),
    );
    expect(linearListKey({ team: "t1" })).not.toBe(
      linearListKey({ team: "t1", showCompleted: true }),
    );
  });
});
