import * as NodeAssert from "node:assert/strict";

import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import type { ServerProviderSkill } from "@t3tools/contracts";
import { describe, it } from "vite-plus/test";

import {
  claudeDisabledInventorySettings,
  claudeInventoryFromProbe,
  withClaudeDisabledInventory,
} from "./ClaudeInventory.ts";

const server = (overrides: Partial<McpServerStatus> & Pick<McpServerStatus, "name">) =>
  ({ status: "connected", ...overrides }) as McpServerStatus;

const listed = (section: ReturnType<typeof claudeInventoryFromProbe>["connectors"]) => {
  NodeAssert.equal(section._tag, "Listed");
  return section._tag === "Listed" ? section.items : [];
};

const success = <A>(value: A) => ({ _tag: "Success" as const, value });

describe("claudeInventoryFromProbe", () => {
  it("splits account connectors from configured and plugin MCP servers", () => {
    const inventory = claudeInventoryFromProbe({
      servers: success([
        server({
          name: "claude.ai Gmail",
          source: "claudeai",
          tools: [{ name: "search" }, { name: "send" }],
        }),
        server({ name: "claude.ai Notion", source: "claudeai", status: "needs-auth" }),
        server({ name: "plugin:design:linear", source: "plugin", status: "failed", error: "boom" }),
        server({ name: "github", scope: "user" }),
        server({ name: "t3-code", source: "sdk" }),
      ]),
      plugins: success([]),
      skills: success([]),
    });

    NodeAssert.deepEqual(listed(inventory.connectors), [
      { id: "claude.ai Gmail", name: "Gmail", status: "connected", toolCount: 2 },
      { id: "claude.ai Notion", name: "Notion", status: "needsAuth" },
    ]);
    NodeAssert.deepEqual(listed(inventory.mcpServers), [
      { id: "github", name: "github", status: "connected" },
      {
        id: "plugin:design:linear",
        name: "linear",
        status: "failed",
        plugin: "design",
        error: "boom",
      },
    ]);
  });

  it("files plugin skills under their plugin and hides built-in plugins", () => {
    const inventory = claudeInventoryFromProbe({
      servers: success([server({ name: "plugin:design:linear", source: "plugin" })]),
      plugins: success([
        { name: "design", source: "design@synced", version: "1.2.0" },
        { name: "cc-plugin-telemetry", source: "cc-plugin-telemetry@builtin" },
      ]),
      skills: success([
        { name: "design:design-critique", description: "Critique" },
        { name: "design:ux-copy", description: "" },
        { name: "pdf", description: "Read PDFs" },
        // A namespace that is not one of the listed plugins stays a skill.
        { name: "anthropic-skills:deep-research", description: "" },
      ]),
    });

    NodeAssert.deepEqual(listed(inventory.plugins), [
      {
        id: "design@synced",
        name: "design",
        description: "2 skills · 1 MCP server · v1.2.0",
      },
    ]);
    NodeAssert.deepEqual(listed(inventory.skills), [
      { id: "anthropic-skills:deep-research", name: "anthropic-skills:deep-research" },
      { id: "pdf", name: "pdf", description: "Read PDFs" },
    ]);
  });
});

describe("claudeDisabledInventorySettings", () => {
  it("is absent when nothing is switched off", () => {
    NodeAssert.equal(claudeDisabledInventorySettings({}), undefined);
  });

  it("denies servers by name, disables plugins and turns skills off", () => {
    NodeAssert.deepEqual(
      claudeDisabledInventorySettings({
        connectors: ["claude.ai Gmail"],
        mcpServers: ["plugin:design:linear"],
        plugins: ["operations@synced"],
        skills: ["pdf"],
      }),
      {
        deniedMcpServers: [
          { serverName: "claude.ai Gmail" },
          { serverName: "plugin:design:linear" },
        ],
        enabledPlugins: { "operations@synced": false },
        skillOverrides: { pdf: "off" },
      },
    );
  });
});

describe("withClaudeDisabledInventory", () => {
  const skill = (name: string): ServerProviderSkill => ({
    name,
    path: `/skills/${name}/SKILL.md`,
    enabled: true,
  });

  it("disables skills by name and plugin skills with their plugin", () => {
    const result = withClaudeDisabledInventory(
      [skill("pdf"), skill("docx"), skill("design:ux-copy"), skill("legal:triage-nda")],
      { skills: ["pdf"], plugins: ["design@synced"] },
    );
    NodeAssert.deepEqual(
      result.map((entry) => [entry.name, entry.enabled]),
      [
        ["pdf", false],
        ["docx", true],
        ["design:ux-copy", false],
        ["legal:triage-nda", true],
      ],
    );
  });
});
