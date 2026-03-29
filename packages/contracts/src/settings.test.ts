import { describe, expect, it } from "vitest";
import { DEFAULT_CLIENT_SETTINGS } from "./settings";

describe("DEFAULT_CLIENT_SETTINGS", () => {
  it("includes assistant response copy format with a markdown default", () => {
    expect(DEFAULT_CLIENT_SETTINGS.assistantResponseCopyFormat).toBe("markdown");
  });

  it("includes archive confirmation with a false default", () => {
    expect(DEFAULT_CLIENT_SETTINGS.confirmThreadArchive).toBe(false);
  });
});
