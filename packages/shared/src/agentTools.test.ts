import {
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  requiredScopesForServerSettingsPatch,
  ServerSettings,
  type McpServerConfig,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { resolveProjectSettings } from "./projectSettings.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

const projectId = ProjectId.make("project-a");

const linear: McpServerConfig = {
  enabled: true,
  transport: { type: "http", url: "https://mcp.linear.app/mcp", headers: [] },
};
const supabase: McpServerConfig = {
  enabled: true,
  transport: {
    type: "stdio",
    command: "npx",
    args: ["-y", "@supabase/mcp-server-supabase"],
    env: [{ name: "SUPABASE_ACCESS_TOKEN", value: "env-token", sensitive: true }],
  },
};

describe("project tools overrides", () => {
  it("merges servers per name so environment servers still reach the project", () => {
    const projectSupabase: McpServerConfig = {
      enabled: true,
      transport: { ...supabase.transport, args: ["--project-ref", "project-db"] } as never,
    };
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      mcpServers: { linear, supabase, sentry: linear },
      projectSettingsOverrides: {
        [projectId]: {
          mcpServers: {
            // Replaces the environment's server of the same name.
            supabase: projectSupabase,
            // Switches an inherited server off without restating it.
            sentry: { enabled: false },
            // A switch for a server the environment no longer has is ignored.
            removed: { enabled: true },
            playwright: {
              enabled: true,
              transport: { type: "stdio", command: "npx", args: ["@playwright/mcp"], env: [] },
            },
          },
        },
      },
    } satisfies ServerSettings;

    const resolved = resolveProjectSettings(settings, projectId);

    expect(resolved.sources.mcpServers).toBe("project");
    expect(resolved.settings.mcpServers).toEqual({
      linear,
      supabase: projectSupabase,
      sentry: { ...linear, enabled: false },
      playwright: {
        enabled: true,
        transport: { type: "stdio", command: "npx", args: ["@playwright/mcp"], env: [] },
      },
    });
  });

  it("turns skills off and back on per project over the environment list", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      disabledSkills: ["grill-me", "prepare-pr"],
      projectSettingsOverrides: {
        [projectId]: { disabledSkills: { "prepare-pr": false, "expo-deployment": true } },
      },
    } satisfies ServerSettings;

    expect(resolveProjectSettings(settings, projectId).settings.disabledSkills).toEqual([
      "expo-deployment",
      "grill-me",
    ]);
    expect(resolveProjectSettings(settings, null).settings.disabledSkills).toEqual([
      "grill-me",
      "prepare-pr",
    ]);
  });
});

describe("mcpServers patches", () => {
  it("replaces one server at a time and removes it with null", () => {
    const current = { ...DEFAULT_SERVER_SETTINGS, mcpServers: { linear, supabase } };
    const switched: McpServerConfig = {
      enabled: true,
      transport: { type: "http", url: "https://example.com/mcp", headers: [] },
    };

    const next = applyServerSettingsPatch(current, {
      mcpServers: { supabase: switched, linear: null },
    });

    // A stdio server edited into an http one keeps no stdio fields.
    expect(next.mcpServers).toEqual({ supabase: switched });
  });

  it("needs provider management to add a server, not to switch one for a project", () => {
    expect(requiredScopesForServerSettingsPatch({ mcpServers: { linear } })).toEqual([
      AuthProvidersManageScope,
    ]);
    expect(
      requiredScopesForServerSettingsPatch({
        projectSettingsOverrides: { [projectId]: { mcpServers: { linear } } },
      }),
    ).toEqual([AuthSettingsWriteScope, AuthProvidersManageScope]);
    expect(
      requiredScopesForServerSettingsPatch({
        projectSettingsOverrides: { [projectId]: { mcpServers: { linear: { enabled: false } } } },
      }),
    ).toEqual([AuthSettingsWriteScope]);
    expect(requiredScopesForServerSettingsPatch({ disabledSkills: ["grill-me"] })).toEqual([
      AuthSettingsWriteScope,
    ]);
  });

  it("rejects T3's own server name", () => {
    const decode = Schema.decodeUnknownExit(ServerSettings);
    expect(decode({ mcpServers: { "t3-code": linear } })._tag).toBe("Failure");
    expect(decode({ mcpServers: { linear } })._tag).toBe("Success");
  });
});
