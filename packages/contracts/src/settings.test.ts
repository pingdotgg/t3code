import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_WORKTREE_BRANCH_PREFIX,
} from "./settings";

describe("ClientSettingsSchema", () => {
  const decode = Schema.decodeSync(ClientSettingsSchema);

  it("includes archive confirmation with a false default", () => {
    expect(DEFAULT_CLIENT_SETTINGS.confirmThreadArchive).toBe(false);
  });

  it("defaults worktreeBranchPrefix to 't3code' when missing from persisted settings", () => {
    const result = decode({});
    expect(result.worktreeBranchPrefix).toBe(DEFAULT_WORKTREE_BRANCH_PREFIX);
  });

  it("preserves a custom worktreeBranchPrefix value", () => {
    const result = decode({ worktreeBranchPrefix: "myteam" });
    expect(result.worktreeBranchPrefix).toBe("myteam");
  });

  it("accepts dotted and digit-prefixed branch prefixes", () => {
    expect(decode({ worktreeBranchPrefix: "my.team" }).worktreeBranchPrefix).toBe("my.team");
    expect(decode({ worktreeBranchPrefix: "3code" }).worktreeBranchPrefix).toBe("3code");
  });

  it("falls back to the default worktreeBranchPrefix for empty or invalid values", () => {
    expect(decode({ worktreeBranchPrefix: "" }).worktreeBranchPrefix).toBe(
      DEFAULT_WORKTREE_BRANCH_PREFIX,
    );
    expect(decode({ worktreeBranchPrefix: "team/name" }).worktreeBranchPrefix).toBe(
      DEFAULT_WORKTREE_BRANCH_PREFIX,
    );
  });

  it("has 't3code' as the default in DEFAULT_CLIENT_SETTINGS", () => {
    expect(DEFAULT_CLIENT_SETTINGS.worktreeBranchPrefix).toBe(DEFAULT_WORKTREE_BRANCH_PREFIX);
  });
});
