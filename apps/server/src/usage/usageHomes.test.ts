import { describe, expect, it } from "@effect/vitest";
import { ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  dedupeUsageHomes,
  listProviderHomeCandidates,
  scanHomePath,
  type ResolvedUsageHome,
} from "./usageHomes.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);

describe("listProviderHomeCandidates", () => {
  it("falls back to the legacy provider blob when no instance claims the default slot", () => {
    const settings = decodeServerSettings({
      providers: { codex: { homePath: "~/.codex-legacy" } },
    });

    const codex = listProviderHomeCandidates(settings, "codex", {});
    expect(codex).toHaveLength(1);
    expect(codex[0]?.config).toMatchObject({ homePath: "~/.codex-legacy" });
    expect(codex[0]?.label).toBeNull();

    const claude = listProviderHomeCandidates(settings, "claude", {});
    expect(claude).toHaveLength(1);
    expect(claude[0]?.config).toMatchObject({ homePath: "" });
  });

  it("prefers an explicit default-slot instance over the legacy blob", () => {
    const settings = decodeServerSettings({
      providers: { codex: { homePath: "~/.codex-legacy" } },
      providerInstances: {
        codex: { driver: "codex", displayName: "Work", config: { homePath: "~/.codex-t3/work" } },
      },
    });

    const codex = listProviderHomeCandidates(settings, "codex", {});
    expect(codex).toHaveLength(1);
    expect(codex[0]?.config).toMatchObject({ homePath: "~/.codex-t3/work" });
    expect(codex[0]?.label).toBe("Work");
  });

  it("returns every instance of the driver and ignores other drivers", () => {
    const settings = decodeServerSettings({
      providerInstances: {
        codex: { driver: "codex", displayName: "Work", config: { homePath: "~/.codex-t3/work" } },
        codex_personal: { driver: "codex", config: { homePath: "~/.codex-t3/personal" } },
        codex_work_overlay: {
          driver: "codex",
          displayName: "Work Overlay",
          config: { homePath: "~/.codex-t3/work", shadowHomePath: "~/.codex-t3/overlay" },
        },
        cursor: { driver: "cursor", config: { binaryPath: "cursor-agent" } },
      },
    });

    const codex = listProviderHomeCandidates(settings, "codex", {});
    expect(codex).toHaveLength(3);
    expect(codex.map((candidate) => (candidate.config as { homePath?: string }).homePath)).toEqual([
      "~/.codex-t3/work",
      "~/.codex-t3/personal",
      "~/.codex-t3/work",
    ]);
    // displayName when set, instance id for named extra instances without one.
    expect(codex.map((candidate) => candidate.label)).toEqual([
      "Work",
      "codex_personal",
      "Work Overlay",
    ]);

    // No explicit claudeAgent instance: the legacy default still applies.
    expect(listProviderHomeCandidates(settings, "claude", {})).toHaveLength(1);
  });

  it("treats an instance without a config payload as driver defaults", () => {
    const settings = decodeServerSettings({
      providerInstances: {
        codex_extra: { driver: "codex" },
      },
    });

    const codex = listProviderHomeCandidates(settings, "codex", {});
    // The config-less instance plus the legacy default slot.
    expect(codex).toHaveLength(2);
    expect(codex[0]).toEqual({
      config: {},
      label: "codex_extra",
      isDefault: false,
      homeEnvValue: null,
    });
    expect(codex[1]?.isDefault).toBe(true);
  });

  it("suppresses the legacy blob when another driver claims the default slot", () => {
    // The registry keys default-slot suppression on the instance id alone, so
    // an id claimed by a different driver still hides the legacy blob.
    const settings = decodeServerSettings({
      providers: { codex: { homePath: "~/.codex-legacy" } },
      providerInstances: {
        codex: { driver: "claudeAgent", config: { homePath: "~/.claude-in-codex-slot" } },
      },
    });

    expect(listProviderHomeCandidates(settings, "codex", {})).toHaveLength(0);
  });

  it("extracts the provider's home variable from the environment entries", () => {
    const settings = decodeServerSettings({
      providerInstances: {
        codex_env: {
          driver: "codex",
          environment: [
            { name: "OPENAI_API_KEY", value: "sk-test", sensitive: true },
            // Later entries win, mirroring mergeProviderInstanceEnvironment.
            { name: "CODEX_HOME", value: "/ignored" },
            { name: "CODEX_HOME", value: "/homes/codex-alt" },
          ],
        },
        claude_env: {
          driver: "claudeAgent",
          environment: [{ name: "CLAUDE_CONFIG_DIR", value: "/homes/claude-alt" }],
        },
        claude_blank: {
          driver: "claudeAgent",
          environment: [{ name: "CLAUDE_CONFIG_DIR", value: "   " }],
        },
      },
    });

    const codex = listProviderHomeCandidates(settings, "codex", {});
    expect(codex[0]?.homeEnvValue).toBe("/homes/codex-alt");

    const claude = listProviderHomeCandidates(settings, "claude", {});
    expect(claude[0]?.homeEnvValue).toBe("/homes/claude-alt");
    // A blank value is unset, like an absent entry.
    expect(claude[1]?.homeEnvValue).toBeNull();
  });

  it("inherits the server's own home variable like the spawn environment does", () => {
    const settings = decodeServerSettings({
      providerInstances: {
        codex_plain: { driver: "codex" },
        codex_override: {
          driver: "codex",
          environment: [{ name: "CODEX_HOME", value: "/homes/override" }],
        },
        codex_cleared: {
          driver: "codex",
          environment: [{ name: "CODEX_HOME", value: "" }],
        },
      },
    });

    const codex = listProviderHomeCandidates(settings, "codex", {
      CODEX_HOME: "/homes/inherited",
    });
    // No per-instance entry: the CLI inherits the server's variable.
    expect(codex[0]?.homeEnvValue).toBe("/homes/inherited");
    // A per-instance entry overrides the inherited value...
    expect(codex[1]?.homeEnvValue).toBe("/homes/override");
    // ...even to unset: the merge writes the blank into the spawn env.
    expect(codex[2]?.homeEnvValue).toBeNull();
    // The legacy default slot inherits too.
    expect(codex[3]?.isDefault).toBe(true);
    expect(codex[3]?.homeEnvValue).toBe("/homes/inherited");
  });

  it("ignores home variable values the scan cannot locate", () => {
    const settings = decodeServerSettings({
      providerInstances: {
        codex_relative: {
          driver: "codex",
          // Relative paths resolve against each workspace's cwd at runtime,
          // so no single directory represents them.
          environment: [{ name: "CODEX_HOME", value: "codex-home" }],
        },
        codex_tilde: {
          driver: "codex",
          // The spawn does not shell-expand `~`; the CLI rejects it verbatim.
          environment: [{ name: "CODEX_HOME", value: "~/codex-home" }],
        },
      },
    });

    const codex = listProviderHomeCandidates(settings, "codex", { CODEX_HOME: "relative-too" });
    expect(codex[0]?.homeEnvValue).toBeNull();
    expect(codex[1]?.homeEnvValue).toBeNull();
  });
});

describe("scanHomePath", () => {
  it("uses the environment value only when no home path is configured", () => {
    expect(scanHomePath("", "/homes/alt", false)).toBe("/homes/alt");
    expect(scanHomePath("~/.codex-t3/work", "/homes/alt", false)).toBe("~/.codex-t3/work");
    expect(scanHomePath("", null, false)).toBe("");
  });

  it("ignores the environment value for a shadowed home", () => {
    // With a shadow home the server always sets the home variable itself and
    // sessions flow through the symlink into the shared home.
    expect(scanHomePath("", "/homes/alt", true)).toBe("");
  });
});

describe("dedupeUsageHomes", () => {
  function home(overrides: Partial<ResolvedUsageHome> = {}): ResolvedUsageHome {
    return {
      provider: "codex",
      dir: "/home/user/.codex/sessions",
      label: null,
      isDirect: true,
      isDefault: false,
      ...overrides,
    };
  }

  it("keeps distinct directories separate and in input order", () => {
    const dirs = dedupeUsageHomes([
      home({ dir: "/a/sessions", label: "Work" }),
      home({ dir: "/b/sessions", label: "Personal" }),
    ]);

    expect(dirs.map((dir) => dir.label)).toEqual(["Work", "Personal"]);
  });

  it("names a shared directory after the direct instance, not an overlay", () => {
    const dirs = dedupeUsageHomes([
      home({ label: "Overlay", isDirect: false }),
      home({ label: "Work", isDirect: true }),
    ]);

    expect(dirs).toHaveLength(1);
    expect(dirs[0]?.label).toBe("Work");
  });

  it("prefers the default slot's label over a named extra sharing its home", () => {
    // A config-less extra instance resolves to the default home; that home's
    // usage renders under the plain provider name, not the extra's.
    const dirs = dedupeUsageHomes([
      home({ label: "codex_extra", isDefault: false }),
      home({ label: null, isDefault: true }),
    ]);

    expect(dirs).toHaveLength(1);
    expect(dirs[0]?.label).toBeNull();
  });

  it("separates equal directories across providers", () => {
    const dirs = dedupeUsageHomes([
      home({ provider: "codex", dir: "/same" }),
      home({ provider: "claude", dir: "/same" }),
    ]);

    expect(dirs).toHaveLength(2);
  });
});
