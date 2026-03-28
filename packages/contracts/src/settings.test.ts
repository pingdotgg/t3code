import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { ClientSettingsSchema, DEFAULT_CLIENT_SETTINGS } from "./settings";

describe("ClientSettingsSchema", () => {
  const decode = Schema.decodeSync(ClientSettingsSchema);

  it("includes archive confirmation with a false default", () => {
    expect(DEFAULT_CLIENT_SETTINGS.confirmThreadArchive).toBe(false);
  });

  it("defaults worktreeBranchPrefix to 't3code' when missing from persisted settings", () => {
    const result = decode({});
    expect(result.worktreeBranchPrefix).toBe("t3code");
  });

  it("preserves a custom worktreeBranchPrefix value", () => {
    const result = decode({ worktreeBranchPrefix: "myteam" });
    expect(result.worktreeBranchPrefix).toBe("myteam");
  });

  it("has 't3code' as the default in DEFAULT_CLIENT_SETTINGS", () => {
    expect(DEFAULT_CLIENT_SETTINGS.worktreeBranchPrefix).toBe("t3code");
  });
});
