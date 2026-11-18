import { describe, expect, it } from "@effect/vitest";

import {
  claudeSettingsRouteThroughCpa,
  codexConfigRoutesThroughCpa,
  setClaudeSettingsCpaRouting,
  setCodexConfigCpaRouting,
} from "./CpaRouting.ts";

const target = {
  url: "http://127.0.0.1:8317",
  clientKeyPath: "~/.config/cpa/key",
  clientKeyFile: "/Users/me/.config/cpa/key",
};

const claudeOn = `{
  "cleanupPeriodDays": 99999,
  "hooks": {
    "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "say done" }] }]
  },
  // comments survive
  "model": "opus",
  "apiKeyHelper": "cat ~/.config/cpa/key",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8317"
  }
}
`;

const claudeOffWithOtherEnv = `{
\t"model": "opus",
\t"env": {
\t\t"FOO": "1"
\t}
}`;

const codexOn = `model_provider = "cpa"
model = "gpt-5.5"
# keep this comment

[projects."/Users/me/code"]
trust_level = "trusted"

[model_providers.cpa]
name = "local CLIProxyAPI"
base_url = "http://127.0.0.1:8317/v1"
wire_api = "responses"

[model_providers.cpa.auth]
command = "cat"
args = ["/Users/me/.config/cpa/key"]
`;

describe("Claude settings CPA routing", () => {
  it("round-trips on → off → on byte for byte and recognises each state", () => {
    expect(claudeSettingsRouteThroughCpa(claudeOn, target.url)).toBe(true);
    const off = setClaudeSettingsCpaRouting(claudeOn, false, target);
    expect(claudeSettingsRouteThroughCpa(off, target.url)).toBe(false);
    expect(off).not.toContain("apiKeyHelper");
    expect(off).not.toContain('"env"');
    expect(off).toContain("// comments survive");
    expect(setClaudeSettingsCpaRouting(off, false, target)).toBe(off);
    const on = setClaudeSettingsCpaRouting(off, true, target);
    expect(on).toBe(claudeOn);
    expect(setClaudeSettingsCpaRouting(on, true, target)).toBe(on);
  });

  it("round-trips off → on → off and keeps unrelated env keys", () => {
    const on = setClaudeSettingsCpaRouting(claudeOffWithOtherEnv, true, target);
    expect(claudeSettingsRouteThroughCpa(on, target.url)).toBe(true);
    expect(on).toContain('"FOO": "1"');
    expect(setClaudeSettingsCpaRouting(on, false, target)).toBe(claudeOffWithOtherEnv);
  });

  it("creates a routed file from nothing and leaves a missing file alone when off", () => {
    expect(setClaudeSettingsCpaRouting("", false, target)).toBe("");
    expect(
      claudeSettingsRouteThroughCpa(setClaudeSettingsCpaRouting("", true, target), target.url),
    ).toBe(true);
  });
});

describe("Codex config CPA routing", () => {
  it("round-trips on → off → on byte for byte and is idempotent", () => {
    expect(codexConfigRoutesThroughCpa(codexOn)).toBe(true);
    const off = setCodexConfigCpaRouting(codexOn, false, target);
    expect(codexConfigRoutesThroughCpa(off)).toBe(false);
    expect(off).toBe(codexOn.slice('model_provider = "cpa"\n'.length));
    expect(setCodexConfigCpaRouting(off, false, target)).toBe(off);
    const on = setCodexConfigCpaRouting(off, true, target);
    expect(on).toBe(codexOn);
    expect(setCodexConfigCpaRouting(on, true, target)).toBe(on);
  });

  it("adds the provider table when missing, and off leaves the table and other providers", () => {
    const plain = `model = "gpt-5.5"\n\n[projects."/x"]\ntrust_level = "trusted"\n`;
    const on = setCodexConfigCpaRouting(plain, true, target);
    expect(on).toBe(
      `model_provider = "cpa"\n${plain}\n${codexOn.slice(codexOn.indexOf("[model_providers.cpa]"))}`,
    );
    const off = setCodexConfigCpaRouting(on, false, target);
    expect(off).toBe(`${plain}\n${codexOn.slice(codexOn.indexOf("[model_providers.cpa]"))}`);
    expect(setCodexConfigCpaRouting(off, true, target)).toBe(on);

    const headroom = `model_provider = "headroom"\n`;
    expect(setCodexConfigCpaRouting(headroom, false, target)).toBe(headroom);
  });

  it("ignores model_provider keys inside tables", () => {
    const profile = `[profiles.work]\nmodel_provider = "cpa"\n`;
    expect(codexConfigRoutesThroughCpa(profile)).toBe(false);
    expect(setCodexConfigCpaRouting(profile, false, target)).toBe(profile);
  });
});
