import {
  type ExtensionMcpServer,
  type ExtensionSkill,
  type ExtensionsListResult,
  type ExtensionsSubscription,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { parseMcpJson, splitCommandLine } from "./extensionsMcpJson";
import {
  attentionCount,
  brokenSkillLinks,
  buildExtensionEntries,
  copyMutation,
  entryDiffers,
  entryHasGap,
  entryMissingIn,
  forgetMcpHealth,
  listNeedsAttention,
  mergeExtensionLists,
  mutationPendingKeys,
  mutationSubjectName,
  subscriptionAttention,
  subscriptionHealthSummary,
  workingSkillCount,
} from "./extensionsModel";

const work = ProviderInstanceId.make("claude-work");
const personal = ProviderInstanceId.make("claude-personal");
const codex = ProviderInstanceId.make("codex");

function server(name: string, patch: Partial<ExtensionMcpServer> = {}): ExtensionMcpServer {
  return {
    name,
    transport: "http",
    target: `https://${name}.example/mcp`,
    secretNames: [],
    enabled: true,
    health: "ok",
    detail: null,
    managedElsewhere: false,
    ...patch,
  };
}

function subscription(
  instanceId: ProviderInstanceId,
  patch: Partial<ExtensionsSubscription> = {},
): ExtensionsSubscription {
  return {
    instanceId,
    driver: ProviderDriverKind.make(instanceId === codex ? "codex" : "claudeAgent"),
    displayName: instanceId,
    accentColor: null,
    configHome: `~/.${instanceId}`,
    capabilities: {
      mcp: true,
      mcpSignIn: true,
      mcpSetEnabled: false,
      plugins: instanceId !== codex,
      skills: true,
    },
    mcpServers: [],
    plugins: [],
    skills: [],
    issues: [],
    ...patch,
  };
}

function list(
  subscriptions: readonly ExtensionsSubscription[],
  patch: Partial<ExtensionsListResult> = {},
): ExtensionsListResult {
  return {
    subscriptions,
    library: { path: "~/.agents/skills", skills: [] },
    checkedAt: "2026-11-26T10:00:00.000Z",
    healthChecked: true,
    ...patch,
  };
}

const entryOf = (result: ExtensionsListResult, key: string) =>
  buildExtensionEntries(result).find((entry) => entry.key === key)!;

describe("buildExtensionEntries", () => {
  it("joins the same name across subscriptions and spots a different target", () => {
    const result = list([
      subscription(work, { mcpServers: [server("papers"), server("github")] }),
      subscription(codex, {
        mcpServers: [server("papers", { target: "https://papers.example/v1/mcp" })],
      }),
    ]);
    const papers = entryOf(result, "mcp:papers");
    expect([...papers.presence.keys()]).toEqual([work, codex]);
    expect(entryDiffers(papers)).toBe(true);
    expect(entryDiffers(entryOf(result, "mcp:github"))).toBe(false);
  });

  it("lists library skills nobody links and treats local copies as differing", () => {
    const result = list(
      [
        subscription(work, {
          skills: [
            {
              name: "animate",
              description: null,
              source: "library",
              path: "~/.agents/skills/animate",
              brokenLink: false,
              libraryCopy: "none",
              health: "unknown",
              detail: null,
            },
            {
              name: "swift",
              description: null,
              source: "local",
              path: "~/.claude-work/skills/swift",
              brokenLink: false,
              libraryCopy: "none",
              health: "unknown",
              detail: null,
            },
          ],
        }),
        subscription(codex, {
          skills: [
            {
              name: "swift",
              description: null,
              source: "local",
              path: "~/.codex/skills/swift",
              brokenLink: false,
              libraryCopy: "none",
              health: "unknown",
              detail: null,
            },
          ],
        }),
      ],
      {
        library: {
          path: "~/.agents/skills",
          skills: [
            { name: "animate", description: "Motion" },
            { name: "unused", description: null },
          ],
        },
      },
    );
    expect(entryOf(result, "skill:unused").presence.size).toBe(0);
    expect(entryOf(result, "skill:animate").description).toBe("Motion");
    expect(entryDiffers(entryOf(result, "skill:animate"))).toBe(false);
    expect(entryDiffers(entryOf(result, "skill:swift"))).toBe(true);
    // A local skill can't be linked elsewhere until it moves to the library.
    expect(entryHasGap(entryOf(result, "skill:swift"), result.subscriptions)).toBe(false);
    expect(entryHasGap(entryOf(result, "skill:unused"), result.subscriptions)).toBe(true);
  });
});

describe("gaps and copying", () => {
  const result = list([
    subscription(work, {
      mcpServers: [server("github", { health: "failing" })],
      plugins: [
        {
          id: "sentry@official",
          name: "sentry",
          marketplace: "official",
          version: "1.3.0",
          description: null,
          enabled: true,
          health: "needsAuth",
          detail: "Its bundled MCP server needs sign-in",
        },
      ],
    }),
    subscription(personal, { mcpServers: [server("github")] }),
    subscription(codex),
  ]);

  it("only counts subscriptions that support the kind", () => {
    const plugin = entryOf(result, "plugin:sentry@official");
    expect(entryMissingIn(plugin, result.subscriptions).map((entry) => entry.instanceId)).toEqual([
      personal,
    ]);
    expect(copyMutation(plugin, [personal])).toEqual({
      _tag: "PluginInstall",
      instanceIds: [personal],
      pluginId: "sentry@official",
    });
  });

  it("copies a server from the subscription where it works", () => {
    expect(copyMutation(entryOf(result, "mcp:github"), [codex])).toEqual({
      _tag: "McpCopy",
      fromInstanceId: personal,
      toInstanceIds: [codex],
      name: "github",
    });
  });

  it("can't copy a server the provider manages", () => {
    const managed = list([
      subscription(work, { mcpServers: [server("drive", { managedElsewhere: true })] }),
      subscription(codex),
    ]);
    const drive = entryOf(managed, "mcp:drive");
    expect(entryHasGap(drive, managed.subscriptions)).toBe(false);
    expect(copyMutation(drive, [codex])).toBeNull();
  });

  it("lists what needs attention, failures first, and ignores what is off", () => {
    const entries = buildExtensionEntries(result);
    expect(
      subscriptionAttention(entries, work).map((item) => [item.entry.name, item.health]),
    ).toEqual([
      ["github", "failing"],
      ["sentry", "needsAuth"],
    ]);
    expect(attentionCount(result)).toBe(2);
    const off = list([
      subscription(work, { mcpServers: [server("github", { health: "failing", enabled: false })] }),
    ]);
    expect(attentionCount(off)).toBe(0);
    expect(listNeedsAttention(off)).toBe(false);
    expect(
      listNeedsAttention(
        list([subscription(work, { issues: [{ kind: "mcp", message: "claude not found" }] })]),
      ),
    ).toBe(true);
  });
});

describe("broken skill links", () => {
  const dead = (name: string): ExtensionSkill => ({
    name,
    description: null,
    source: "library",
    path: `~/.gemini/skills/${name}`,
    brokenLink: true,
    libraryCopy: "none",
    health: "failing",
    detail: "The link points to a skill that no longer exists",
  });
  const result = list(
    [
      subscription(codex, {
        capabilities: {
          mcp: true,
          mcpSignIn: false,
          mcpSetEnabled: false,
          plugins: false,
          skills: false,
        },
        skills: [
          dead("expo-router"),
          dead("react-hooks"),
          {
            name: "swift",
            description: null,
            source: "local",
            path: "~/.gemini/skills/swift",
            brokenLink: false,
            libraryCopy: "different",
            health: "unknown",
            detail: null,
          },
        ],
      }),
    ],
    { library: { path: "~/.agents/skills", skills: [{ name: "swift", description: null }] } },
  );

  it("are not skills, in the library or anywhere else", () => {
    const entries = buildExtensionEntries(result);
    expect(entries.map((entry) => entry.key)).toEqual(["skill:swift"]);
    expect(entries[0]!.presence.get(codex)!.libraryCopy).toBe("different");
    expect(workingSkillCount(result.subscriptions[0]!)).toBe(1);
  });

  it("count as one warning however many there are", () => {
    expect(brokenSkillLinks(result.subscriptions[0]!).map((skill) => skill.name)).toEqual([
      "expo-router",
      "react-hooks",
    ]);
    expect(subscriptionHealthSummary(result.subscriptions[0]!)).toEqual({
      failing: 0,
      warnings: 1,
    });
    expect(attentionCount(result)).toBe(1);
    expect(listNeedsAttention(result)).toBe(true);
  });

  it("keep their own pending key", () => {
    expect(mutationPendingKeys({ _tag: "SkillRemoveBrokenLinks", instanceId: codex })).toEqual([
      `${codex}|skill-broken-links`,
    ]);
    expect(mutationSubjectName({ _tag: "SkillRemoveBrokenLinks", instanceId: codex })).toBeNull();
  });
});

describe("mergeExtensionLists", () => {
  const checked = list([
    subscription(work, {
      mcpServers: [server("github", { health: "needsAuth", detail: "Sign in" }), server("old")],
    }),
  ]);
  const fast = list(
    [
      subscription(work, {
        mcpServers: [
          server("github", { health: "unknown" }),
          server("old", { health: "unknown", target: "https://moved.example/mcp" }),
          server("new", { health: "unknown" }),
        ],
      }),
    ],
    { checkedAt: "2026-11-26T10:05:00.000Z", healthChecked: false },
  );

  it("keeps the newer structure and the health of servers that did not change", () => {
    const merged = mergeExtensionLists(fast, checked)!;
    expect(
      merged.subscriptions[0]!.mcpServers.map((entry) => [entry.name, entry.health, entry.detail]),
    ).toEqual([
      ["github", "needsAuth", "Sign in"],
      ["old", "unknown", null],
      ["new", "unknown", null],
    ]);
    expect(merged.healthChecked).toBe(true);
    expect(mergeExtensionLists(checked, fast)).toEqual(merged);
  });

  it("returns the one list there is", () => {
    expect(mergeExtensionLists(null, fast)).toBe(fast);
    expect(mergeExtensionLists(null, null)).toBeNull();
  });

  it("forgets the health of a server that was just changed", () => {
    const merged = mergeExtensionLists(fast, forgetMcpHealth(checked, [work], "github"))!;
    expect(merged.subscriptions[0]!.mcpServers[0]!.health).toBe("unknown");
  });
});

describe("mutationPendingKeys", () => {
  it("marks every target subscription of a copy", () => {
    expect(
      mutationPendingKeys({
        _tag: "McpCopy",
        fromInstanceId: work,
        toInstanceIds: [personal, codex],
        name: "github",
      }),
    ).toEqual([`${personal}|mcp:github`, `${codex}|mcp:github`]);
  });
});

describe("parseMcpJson", () => {
  it("reads the mcpServers shape and names the secrets", () => {
    const parsed = parseMcpJson(
      JSON.stringify({
        mcpServers: {
          sentry: { type: "http", url: "https://mcp.sentry.dev/mcp" },
          linear: { command: "npx", args: ["-y", "mcp-remote"], env: { LINEAR_API_KEY: "x" } },
          events: { type: "sse", url: "https://e.example/sse", headers: { Authorization: "y" } },
          broken: { note: "nothing to run" },
        },
      }),
    );
    expect(parsed.problem).toBeNull();
    expect(parsed.skipped).toEqual(["broken"]);
    expect(parsed.servers).toEqual([
      {
        name: "sentry",
        spec: { _tag: "remote", transport: "http", url: "https://mcp.sentry.dev/mcp", headers: {} },
        secretNames: [],
      },
      {
        name: "linear",
        spec: {
          _tag: "stdio",
          command: "npx",
          args: ["-y", "mcp-remote"],
          env: { LINEAR_API_KEY: "x" },
        },
        secretNames: ["LINEAR_API_KEY"],
      },
      {
        name: "events",
        spec: {
          _tag: "remote",
          transport: "sse",
          url: "https://e.example/sse",
          headers: { Authorization: "y" },
        },
        secretNames: ["Authorization"],
      },
    ]);
  });

  it("accepts a bare member copied without its braces", () => {
    const parsed = parseMcpJson('"github": { "command": "gh-mcp" },');
    expect(parsed.servers.map((entry) => entry.name)).toEqual(["github"]);
  });

  it("says what is wrong", () => {
    expect(parseMcpJson("").problem).toBeNull();
    expect(parseMcpJson("{ nope").problem).toBe("syntax");
    expect(parseMcpJson('{ "command": "npx" }').problem).toBe("unnamed");
    expect(parseMcpJson('{ "mcpServers": {} }').problem).toBe("empty");
  });
});

describe("splitCommandLine", () => {
  it("keeps quoted arguments whole", () => {
    expect(splitCommandLine(`npx -y "my server" 'a b'`)).toEqual(["npx", "-y", "my server", "a b"]);
  });
});
