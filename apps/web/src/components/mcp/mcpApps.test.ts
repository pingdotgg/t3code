import { describe, expect, it } from "vite-plus/test";

import { MCP_APPS, mcpHandoffLink } from "./mcpApps";

const MCP_URL = "https://prod-a1.t3coderelay.com/mcp?x=1&y=two words";

describe("MCP app links", () => {
  it("fill in T3 Code and the encoded URL", () => {
    const opened = (id: string) => {
      const app = MCP_APPS.find((candidate) => candidate.id === id)!;
      return new URL(mcpHandoffLink(app.handoff, MCP_URL)!);
    };
    const poke = opened("poke");
    expect(poke.searchParams.get("name")).toBe("T3 Code");
    expect(poke.searchParams.get("url")).toBe(MCP_URL);
    const claude = opened("claude");
    expect(claude.searchParams.get("connectorName")).toBe("T3 Code");
    expect(claude.searchParams.get("connectorUrl")).toBe(MCP_URL);
  });

  // The desktop app opens only http and https links.
  it.each(MCP_APPS.map((app) => [app.name, app] as const))("%s opens only https", (_, app) => {
    const link = mcpHandoffLink(app.handoff, MCP_URL);
    for (const url of [link, app.docs].filter((value) => value != null)) {
      expect(new URL(url).protocol).toBe("https:");
    }
  });
});
