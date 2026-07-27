import type { McpServerInventory, McpServerInventoryEntry } from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  filterMcpInventory,
  formatMcpConfigPath,
  groupMcpServersByHarness,
  withServerEnabled,
} from "./McpServersSettings.logic";

const makeServer = (
  overrides: Partial<McpServerInventoryEntry> & Pick<McpServerInventoryEntry, "name">,
): McpServerInventoryEntry => ({
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  harness: ProviderDriverKind.make("claudeAgent"),
  harnessDisplayName: "Claude",
  transport: "stdio",
  enabled: true,
  toggleable: true,
  ...overrides,
});

const inventoryOf = (servers: ReadonlyArray<McpServerInventoryEntry>): McpServerInventory => ({
  scannedAt: "2026-07-27T00:00:00.000Z",
  servers,
});

describe("filterMcpInventory", () => {
  it("matches name, detail, harness, and transport", () => {
    const inventory = inventoryOf([
      makeServer({ name: "codegraph", detail: "codegraph serve --mcp" }),
      makeServer({
        name: "remote",
        transport: "http",
        detail: "https://example.com/mcp",
        harnessDisplayName: "Codex",
        harness: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
      }),
    ]);

    expect(filterMcpInventory(inventory, "serve").servers.map((s) => s.name)).toEqual([
      "codegraph",
    ]);
    expect(filterMcpInventory(inventory, "codex").servers.map((s) => s.name)).toEqual(["remote"]);
    expect(filterMcpInventory(inventory, "http").servers.map((s) => s.name)).toEqual(["remote"]);
    expect(filterMcpInventory(inventory, "  ").servers).toHaveLength(2);
  });
});

describe("groupMcpServersByHarness", () => {
  it("buckets by instance and preserves inventory order", () => {
    const groups = groupMcpServersByHarness([
      makeServer({ name: "b" }),
      makeServer({
        name: "a",
        harnessDisplayName: "Codex",
        harness: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
      }),
      makeServer({ name: "c" }),
    ]);

    expect(groups.map((group) => group.harnessDisplayName)).toEqual(["Claude", "Codex"]);
    expect(groups[0]?.servers.map((server) => server.name)).toEqual(["b", "c"]);
  });
});

describe("withServerEnabled", () => {
  it("flips only the targeted server", () => {
    const inventory = inventoryOf([
      makeServer({ name: "codegraph" }),
      makeServer({ name: "alpaca" }),
    ]);

    const next = withServerEnabled(
      inventory,
      { providerInstanceId: "claudeAgent", name: "alpaca" },
      false,
    );

    expect(next.servers.map((server) => server.enabled)).toEqual([true, false]);
  });
});

describe("formatMcpConfigPath", () => {
  it("shortens home-relative and deep paths", () => {
    expect(formatMcpConfigPath("/Users/mark/.claude.json")).toBe("~/.claude.json");
    expect(formatMcpConfigPath("/Users/mark/a/b/c/d/.claude.json")).toBe("…/c/d/.claude.json");
  });
});
