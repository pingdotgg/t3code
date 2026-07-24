import { describe, expect, it } from "vite-plus/test";

import { parseIssueReference } from "./issueReference";

describe("parseIssueReference", () => {
  it("accepts GitHub issue URLs", () => {
    expect(parseIssueReference("https://github.com/pingdotgg/t3code/issues/42")).toBe(
      "https://github.com/pingdotgg/t3code/issues/42",
    );
  });

  it("accepts numbers with or without a hash", () => {
    expect(parseIssueReference("42")).toBe("42");
    expect(parseIssueReference("#42")).toBe("42");
  });

  it("rejects unrelated input", () => {
    expect(parseIssueReference("draft-page")).toBeNull();
  });
});
