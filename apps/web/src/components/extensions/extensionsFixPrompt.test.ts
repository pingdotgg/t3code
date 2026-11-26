import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { type ExtensionFixProblem, buildExtensionFixPrompt } from "./extensionsFixPrompt";

const claude = {
  displayName: "Claude Work",
  driver: ProviderDriverKind.make("claudeAgent"),
  configHome: "~/.claude-work",
};
const codex = {
  displayName: "Codex",
  driver: ProviderDriverKind.make("codex"),
  configHome: "~/.codex",
};

function server(patch: Partial<Extract<ExtensionFixProblem, { type: "extension" }>>) {
  return {
    type: "extension",
    kind: "mcp",
    name: "github",
    id: "github",
    health: "needsAuth",
    detail: "Needs authentication",
    transport: "http",
    target: "https://api.githubcopilot.com/mcp/",
    managedElsewhere: false,
    path: null,
    ...patch,
  } satisfies ExtensionFixProblem;
}

describe("buildExtensionFixPrompt", () => {
  it("signs a Claude server in against that subscription's config home", () => {
    const { prompt, manual } = buildExtensionFixPrompt(server({}), claude);
    expect(prompt).toContain('the MCP server "github", which needs a sign-in');
    expect(prompt).toContain('"Claude Work" subscription');
    expect(prompt).toContain("Its config home is ~/.claude-work.");
    expect(prompt).toContain("The exact error: Needs authentication");
    expect(prompt).toContain('`CLAUDE_CONFIG_DIR=~/.claude-work claude mcp login "github"`');
    expect(prompt).toContain("run /mcp");
    expect(prompt).toContain('`CLAUDE_CONFIG_DIR=~/.claude-work claude mcp get "github"`');
    expect(manual).toContain("claude mcp login");
  });

  it("uses Codex's own login and home", () => {
    const { prompt } = buildExtensionFixPrompt(server({}), codex);
    expect(prompt).toContain('`CODEX_HOME=~/.codex codex mcp login "github"`');
    expect(prompt).not.toContain("CLAUDE_CONFIG_DIR");
  });

  it("sends a claude.ai connector to the connectors page, not to a command", () => {
    const { prompt, manual } = buildExtensionFixPrompt(
      server({ name: "claude.ai Microsoft 365", managedElsewhere: true }),
      claude,
    );
    expect(prompt).toContain("https://claude.ai/settings/connectors");
    expect(prompt).toContain('find "Microsoft 365"');
    expect(prompt).not.toContain("mcp login");
    expect(manual).toBe("Reconnect it at https://claude.ai/settings/connectors.");
  });

  it("checks a failing stdio server's command and runs it once", () => {
    const { prompt } = buildExtensionFixPrompt(
      server({
        name: "analytics-mcp",
        health: "failing",
        transport: "stdio",
        target: "pipx run analytics-mcp",
        detail: "spawn pipx ENOENT",
      }),
      claude,
    );
    expect(prompt).toContain("which is failing");
    expect(prompt).toContain("It is set up as (stdio): pipx run analytics-mcp");
    expect(prompt).toContain("`which pipx`");
    expect(prompt).toContain("`pipx run analytics-mcp`");
    expect(prompt).toContain("The exact error: spawn pipx ENOENT");
  });

  it("asks for a description in a skill's front matter", () => {
    const { prompt } = buildExtensionFixPrompt(
      server({
        kind: "skill",
        name: "notes",
        health: "failing",
        transport: null,
        target: null,
        path: "~/.codex/skills/notes",
        detail: "SKILL.md has no description",
      }),
      codex,
    );
    expect(prompt).toContain("~/.codex/skills/notes/SKILL.md");
    expect(prompt).toContain("`description:`");
  });

  it("lists every broken link and removes only those", () => {
    const { prompt, manual } = buildExtensionFixPrompt(
      {
        type: "brokenLinks",
        links: [
          { name: "expo-router", path: "~/.gemini/skills/expo-router" },
          { name: "react-hooks", path: "~/.gemini/skills/react-hooks" },
        ],
      },
      { ...codex, displayName: "Antigravity" },
    );
    expect(prompt).toContain("2 broken skill links");
    expect(prompt).toContain("- expo-router: ~/.gemini/skills/expo-router");
    expect(prompt).toContain("`ls -l ~/.gemini/skills`");
    expect(prompt).toContain("Remove only the dead links");
    expect(manual).toContain("~/.gemini/skills");
  });
});
