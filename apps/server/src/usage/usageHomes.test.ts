import { describe, expect, it } from "@effect/vitest";
import { ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { listProviderHomeCandidates, scanHomePath } from "./usageHomes.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);

describe("listProviderHomeCandidates", () => {
  it("falls back to the legacy provider blob when no instance claims the default slot", () => {
    const settings = decodeServerSettings({
      providers: { codex: { homePath: "~/.codex-legacy" } },
    });

    const codex = listProviderHomeCandidates(settings, "codex", {});
    expect(codex).toHaveLength(1);
    expect(codex[0]?.config).toMatchObject({ homePath: "~/.codex-legacy" });

    const claude = listProviderHomeCandidates(settings, "claude", {});
    expect(claude).toHaveLength(1);
    expect(claude[0]?.config).toMatchObject({ homePath: "" });
  });

  it("prefers an explicit default-slot instance over the legacy blob", () => {
    const settings = decodeServerSettings({
      providers: { codex: { homePath: "~/.codex-legacy" } },
      providerInstances: {
        codex: { driver: "codex", config: { homePath: "~/.codex-t3/work" } },
      },
    });

    const codex = listProviderHomeCandidates(settings, "codex", {});
    expect(codex).toHaveLength(1);
    expect(codex[0]?.config).toMatchObject({ homePath: "~/.codex-t3/work" });
  });

  it("returns every instance of the driver and ignores other drivers", () => {
    const settings = decodeServerSettings({
      providerInstances: {
        codex: { driver: "codex", config: { homePath: "~/.codex-t3/work" } },
        codex_personal: { driver: "codex", config: { homePath: "~/.codex-t3/personal" } },
        codex_work_overlay: {
          driver: "codex",
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
    expect(codex[0]).toEqual({ config: {}, homeEnvValue: null });
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
