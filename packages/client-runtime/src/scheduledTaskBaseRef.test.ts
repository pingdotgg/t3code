import { describe, expect, it } from "vite-plus/test";

import { defaultWorktreeBaseRef } from "./scheduledTaskBaseRef.ts";

const ref = (name: string, flags: { isDefault?: boolean; current?: boolean } = {}) => ({
  name,
  isDefault: flags.isDefault ?? false,
  current: flags.current ?? false,
});

describe("defaultWorktreeBaseRef", () => {
  it("keeps main wherever the repo has it, even when origin's default differs", () => {
    expect(defaultWorktreeBaseRef([ref("develop", { isDefault: true }), ref("main")])).toBe("main");
    expect(defaultWorktreeBaseRef([ref("develop", { isDefault: true }), ref("origin/main")])).toBe(
      "main",
    );
  });
  it("starts from the repo's default branch when there is no main", () => {
    expect(
      defaultWorktreeBaseRef([
        ref("feature", { current: true }),
        ref("master", { isDefault: true }),
      ]),
    ).toBe("master");
  });
  it("falls back to the checked-out branch when no default is known", () => {
    expect(defaultWorktreeBaseRef([ref("trunk", { current: true }), ref("other")])).toBe("trunk");
  });
  it("leaves the choice empty while refs are unknown", () => {
    expect(defaultWorktreeBaseRef([])).toBe("");
  });
});
