import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  DEFAULT_TEAM_HARNESS_PROFILE,
  TEAM_HARNESS_PROFILES,
  TEAM_PROVIDER_PROFILE_ENV_VARS,
  getTeamHarnessProfile,
  isAllowedBwrapShadowProfileLeaf,
} from "./harnessProfiles.ts";

describe("harnessProfiles", () => {
  it("resolves declarative profile metadata for built-in harnesses and unknown drivers", () => {
    const antigravity = getTeamHarnessProfile(ProviderDriverKind.make("antigravity"));
    expect(antigravity.profileEnvVar).toBe("GEMINI_HOME");
    expect(antigravity.threadInstructionFilename).toBe("GEMINI.md");
    expect(antigravity.cachesTokenInRam).toBe(true);
    expect(antigravity.ephemeralTokenFormat).toBe("antigravity-oauth-json");
    expect(antigravity.personalSkillLayout.kind).toBe("antigravity-config-and-plugins");
    expect(antigravity.deliveryCapabilities).toEqual(["proxy", "token-lease", "remote-only"]);

    const codex = getTeamHarnessProfile(ProviderDriverKind.make("codex"));
    expect(codex.profileEnvVar).toBe("CODEX_HOME");
    expect(codex.threadInstructionFilename).toBe("AGENTS.md");
    expect(codex.turnInjectionStrategy).toBe("codex-additional-context");
    expect(codex.cachesTokenInRam).toBe(false);
    expect(codex.ephemeralTokenFormat).toBe("in-memory");
    expect(codex.ephemeralTokenRelativePaths).toEqual([]);
    expect(codex.tokenLeaseSetupMode).toBe("managed");

    const claude = getTeamHarnessProfile(ProviderDriverKind.make("claudeAgent"));
    expect(claude.profileEnvVar).toBe("CLAUDE_CONFIG_DIR");
    expect(claude.threadInstructionFilename).toBe("CLAUDE.md");
    expect(claude.cachesTokenInRam).toBe(true);
    expect(claude.ephemeralTokenFormat).toBe("claude-credentials-json");
    expect(claude.extraStrippedAmbientEnv).toContain("CLAUDE_CODE_OAUTH_TOKEN");

    const fallback = getTeamHarnessProfile("custom-acp");
    expect(fallback).toBe(DEFAULT_TEAM_HARNESS_PROFILE);
    expect(fallback.profileEnvVar).toBe("T3_TEAM_PROFILE_DIR");
    expect(fallback.threadInstructionFilename).toBeNull();
    expect(fallback.cachesTokenInRam).toBe(false);
  });

  it("derives bwrap profile env vars and shadow leaf rules from the registry", () => {
    for (const spec of Object.values(TEAM_HARNESS_PROFILES)) {
      expect(TEAM_PROVIDER_PROFILE_ENV_VARS).toContain(spec.profileEnvVar);
    }
    expect(TEAM_PROVIDER_PROFILE_ENV_VARS).toContain(DEFAULT_TEAM_HARNESS_PROFILE.profileEnvVar);
    expect(isAllowedBwrapShadowProfileLeaf("codex", "shadow")).toBe(true);
    expect(isAllowedBwrapShadowProfileLeaf("codex", "other")).toBe(false);
    expect(isAllowedBwrapShadowProfileLeaf("antigravity", "shadow")).toBe(false);
  });
});
