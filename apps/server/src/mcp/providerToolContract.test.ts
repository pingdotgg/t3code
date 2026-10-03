import { describe, expect, it } from "vitest";

import { fingerprintProviderMcpToolContract, providerMcpTools } from "./providerToolContract.ts";

describe("providerMcpToolContract", () => {
  it("fingerprints every tool served to provider MCP sessions", () => {
    // A toolkit that is registered on the provider MCP server but missing here
    // cannot be detected by a live session, so it never refreshes its tools.
    const names = providerMcpTools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "delegate_work",
        "acceptance_submit_candidate",
        "pr_monitor_context",
        "terminal_start",
        "preview_snapshot",
      ]),
    );
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort((left, right) => left.localeCompare(right))).toEqual(names);
  });

  it("keeps the fingerprint deterministic for a stable tool set", () => {
    expect(fingerprintProviderMcpToolContract()).toBe(fingerprintProviderMcpToolContract());
  });
});
