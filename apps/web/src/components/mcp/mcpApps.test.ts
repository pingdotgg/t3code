import { describe, expect, it } from "vite-plus/test";

import { MCP_APPS, mcpHandoffAction } from "./mcpApps";

const MCP_URL = "https://prod-a1.t3coderelay.com/mcp?x=1&y=two words";

describe("MCP app links", () => {
  it("fill in T3 Code and the encoded URL", () => {
    const opened = (id: string) => {
      const app = MCP_APPS.find((candidate) => candidate.id === id)!;
      return new URL(mcpHandoffAction(app, MCP_URL)!.link!);
    };
    const poke = opened("poke");
    expect(poke.searchParams.get("name")).toBe("T3 Code");
    expect(poke.searchParams.get("url")).toBe(MCP_URL);
    const claude = opened("claude");
    expect(claude.searchParams.get("connectorName")).toBe("T3 Code");
    expect(claude.searchParams.get("connectorUrl")).toBe(MCP_URL);
  });

  it("copies agent prompts for Claude Code and Codex without opening a link", () => {
    for (const id of ["claude-code", "codex"] as const) {
      const app = MCP_APPS.find((candidate) => candidate.id === id)!;
      const action = mcpHandoffAction(app, MCP_URL)!;
      expect(action.link).toBeNull();
      expect(action.copy?.text).toContain(MCP_URL);
      expect(action.label).toContain(app.name);
      expect(app.handoff.kind).toBe("copy-prompt");
      if (app.handoff.kind !== "copy-prompt") throw new Error("expected copy-prompt");
      expect(app.handoff.commands(MCP_URL).some((command) => command.includes(MCP_URL))).toBe(true);
    }
  });

  // The desktop app opens only https links and the bare app launch links it lists.
  it.each(MCP_APPS.map((app) => [app.name, app] as const))("%s opens only https", (_, app) => {
    const action = mcpHandoffAction(app, MCP_URL);
    for (const url of [action?.link, app.docs].filter((value) => value != null)) {
      expect(new URL(url).protocol).toBe("https:");
    }
    expect(action?.appLink ?? null).toBe(app.id === "grok-bot" ? "grokbot://app" : null);
  });
});
