import * as NodeAssert from "node:assert/strict";

import type { ServerProviderSkill } from "@t3tools/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";
import { describe, it } from "vite-plus/test";

import {
  codexDisabledInventoryArgs,
  codexInventoryFromProbe,
  withCodexDisabledInventory,
  type CodexInventoryProbe,
} from "./CodexInventory.ts";

type McpServerStatus = CodexSchema.V2ListMcpServerStatusResponse["data"][number];
type PluginMarketplace = CodexSchema.V2PluginInstalledResponse["marketplaces"][number];

const mcpServer = (overrides: Partial<McpServerStatus> & Pick<McpServerStatus, "name">) =>
  ({
    authStatus: "unsupported",
    resources: [],
    resourceTemplates: [],
    tools: {},
    ...overrides,
  }) as McpServerStatus;

const success = <A>(value: A) => ({ _tag: "Success" as const, value });

const probe = (overrides: Partial<CodexInventoryProbe>): CodexInventoryProbe => ({
  mcpServers: success([]),
  plugins: success([]),
  apps: success([]),
  skills: success([]),
  ...overrides,
});

describe("codexInventoryFromProbe", () => {
  it("lists ChatGPT connectors instead of the proxy server that serves them", () => {
    const inventory = codexInventoryFromProbe(
      probe({
        mcpServers: success([
          mcpServer({ name: "codex_apps", tools: { a: {} as never } }),
          mcpServer({ name: "github", tools: { a: {} as never, b: {} as never } }),
          mcpServer({ name: "linear", authStatus: "notLoggedIn" }),
          mcpServer({ name: "broken", toolsError: "MCP startup failed" }),
        ]),
        apps: success([
          { id: "connector_gmail", runtimeName: "Gmail", enabled: true, callable: true },
          { id: "connector_drive", runtimeName: null, enabled: false, callable: false },
        ]),
      }),
    );

    NodeAssert.deepEqual(inventory.connectors, {
      _tag: "Listed",
      canDisable: true,
      items: [
        { id: "connector_drive", name: "connector_drive", status: "disabled" },
        { id: "connector_gmail", name: "Gmail", status: "connected" },
      ],
    });
    NodeAssert.deepEqual(inventory.mcpServers, {
      _tag: "Listed",
      canDisable: false,
      items: [
        { id: "broken", name: "broken", status: "failed", error: "MCP startup failed" },
        { id: "github", name: "github", status: "connected", toolCount: 2 },
        { id: "linear", name: "linear", status: "needsAuth", toolCount: 0 },
      ],
    });
  });

  it("reports a section that failed without hiding the others", () => {
    const inventory = codexInventoryFromProbe(
      probe({
        plugins: { _tag: "Failure", message: "Codex could not list its plugins." },
        skills: success<ReadonlyArray<ServerProviderSkill>>([
          {
            name: "imagegen",
            path: "/codex/skills/imagegen/SKILL.md",
            enabled: false,
            shortDescription: "Make images",
          },
        ]),
      }),
    );

    NodeAssert.deepEqual(inventory.plugins, {
      _tag: "Failed",
      message: "Codex could not list its plugins.",
    });
    NodeAssert.deepEqual(inventory.skills, {
      _tag: "Listed",
      canDisable: true,
      items: [
        {
          id: "/codex/skills/imagegen/SKILL.md",
          name: "imagegen",
          description: "Make images",
          status: "disabled",
        },
      ],
    });
  });

  it("lists only installed plugins, by their display name", () => {
    const inventory = codexInventoryFromProbe(
      probe({
        plugins: success([
          {
            name: "openai-curated",
            plugins: [
              {
                id: "tailscale@openai-curated",
                name: "tailscale",
                installed: true,
                enabled: true,
                interface: { displayName: "Tailscale", shortDescription: "Connect devices" },
              },
              { id: "other@openai-curated", name: "other", installed: false, enabled: false },
            ],
          } as unknown as PluginMarketplace,
        ]),
      }),
    );

    NodeAssert.deepEqual(inventory.plugins, {
      _tag: "Listed",
      canDisable: false,
      items: [
        { id: "tailscale@openai-curated", name: "Tailscale", description: "Connect devices" },
      ],
    });
  });
});

describe("codexDisabledInventoryArgs", () => {
  it("passes nothing when nothing is switched off", () => {
    NodeAssert.deepEqual(codexDisabledInventoryArgs({}), []);
  });

  it("overrides connectors by id and skills by path for this process", () => {
    NodeAssert.deepEqual(
      codexDisabledInventoryArgs({
        connectors: ["connector_gmail", "has.dot"],
        skills: ['/home/me/skills/say "hi"/SKILL.md'],
        // Codex hangs on start when a disabled server is missing from its config.
        mcpServers: ["github"],
      }),
      [
        "-c",
        "apps.connector_gmail.enabled=false",
        "-c",
        'skills.config=[{path="/home/me/skills/say \\"hi\\"/SKILL.md",enabled=false}]',
      ],
    );
  });
});

describe("withCodexDisabledInventory", () => {
  it("disables skills by path", () => {
    const skills: ReadonlyArray<ServerProviderSkill> = [
      { name: "imagegen", path: "/a/SKILL.md", enabled: true },
      { name: "docs", path: "/b/SKILL.md", enabled: true },
    ];
    NodeAssert.deepEqual(
      withCodexDisabledInventory(skills, { skills: ["/a/SKILL.md"] }).map((skill) => skill.enabled),
      [false, true],
    );
  });
});
