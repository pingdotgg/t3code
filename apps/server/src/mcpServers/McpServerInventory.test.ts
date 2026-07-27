import { assert, describe, it } from "@effect/vitest";

import { stdioDetail } from "./McpServerInventory.ts";

describe("stdioDetail", () => {
  it("keeps ordinary arguments so servers stay identifiable", () => {
    assert.equal(
      stdioDetail("npx", ["--yes", "xcodebuildmcp@2.6.2", "mcp"]),
      "npx --yes xcodebuildmcp@2.6.2 mcp",
    );
    assert.equal(stdioDetail("codegraph", undefined), "codegraph");
  });

  it("redacts secrets passed as flag values", () => {
    assert.equal(
      stdioDetail("server", ["--token", "abc123", "--port", "8080"]),
      "server --token … --port 8080",
    );
    assert.equal(stdioDetail("server", ["--api-key=abc123"]), "server --api-key=…");
    assert.equal(stdioDetail("server", ["--password", "hunter2"]), "server --password …");
  });

  it("ignores non-string arguments", () => {
    assert.equal(stdioDetail("server", ["--flag", 42, null]), "server --flag");
  });
});
