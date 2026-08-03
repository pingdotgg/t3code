import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type SystemPromptInjectionSettings,
  type SystemPromptRule,
} from "@t3tools/contracts";

import {
  buildSystemPromptPreview,
  EMPTY_SYSTEM_PROMPT_INJECTION,
  GLOBAL_SYSTEM_PROMPT_RULE_ID,
  readSystemPromptRule,
  removeSystemPromptRule,
  setSystemPromptRuleEnabled,
  systemPromptOverrideCandidates,
  systemPromptRuleId,
  upsertSystemPromptRule,
} from "./systemPrompt.ts";

const CODEX_INSTANCE = ProviderInstanceId.make("codex");
const CURSOR_INSTANCE = ProviderInstanceId.make("cursor");

const rule = (
  id: string,
  text: string,
  match: SystemPromptRule["match"] = {},
): SystemPromptRule => ({
  id,
  enabled: true,
  match,
  text,
});

const settings = (rules: ReadonlyArray<SystemPromptRule>): SystemPromptInjectionSettings => ({
  ...EMPTY_SYSTEM_PROMPT_INJECTION,
  rules,
});

const provider = (instanceId: ProviderInstanceId, driver: string, enabled = true): ServerProvider =>
  ({
    instanceId,
    driver: ProviderDriverKind.make(driver),
    enabled,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  }) satisfies ServerProvider;

describe("systemPromptRuleId", () => {
  it("derives a stable id per scope", () => {
    expect(systemPromptRuleId()).toBe(GLOBAL_SYSTEM_PROMPT_RULE_ID);
    expect(systemPromptRuleId(CODEX_INSTANCE)).toBe("instance:codex");
  });
});

describe("upsertSystemPromptRule", () => {
  it("keeps the global rule first and appends overrides", () => {
    const withOverride = upsertSystemPromptRule(
      settings([]),
      rule(systemPromptRuleId(CODEX_INSTANCE), "codex", { instanceId: CODEX_INSTANCE }),
    );
    const withGlobal = upsertSystemPromptRule(
      withOverride,
      rule(GLOBAL_SYSTEM_PROMPT_RULE_ID, "global"),
    );

    expect(withGlobal.rules.map((entry) => entry.id)).toEqual([
      GLOBAL_SYSTEM_PROMPT_RULE_ID,
      "instance:codex",
    ]);
  });

  it("replaces an existing rule in place", () => {
    const initial = settings([rule("global", "first"), rule("instance:codex", "codex")]);
    const next = upsertSystemPromptRule(initial, rule("global", "second"));

    expect(next.rules.map((entry) => entry.text)).toEqual(["second", "codex"]);
  });
});

describe("rule mutation helpers", () => {
  it("reads a rule by scope", () => {
    const current = settings([rule("instance:codex", "codex", { instanceId: CODEX_INSTANCE })]);
    expect(readSystemPromptRule(current, CODEX_INSTANCE)?.text).toBe("codex");
    expect(readSystemPromptRule(current)).toBeUndefined();
  });

  it("removes and toggles by id", () => {
    const current = settings([rule("global", "g"), rule("instance:codex", "c")]);
    expect(removeSystemPromptRule(current, "global").rules.map((entry) => entry.id)).toEqual([
      "instance:codex",
    ]);
    expect(setSystemPromptRuleEnabled(current, "global", false).rules[0]?.enabled).toBe(false);
    expect(setSystemPromptRuleEnabled(current, "global", false).rules[1]?.enabled).toBe(true);
  });
});

describe("systemPromptOverrideCandidates", () => {
  it("lists enabled instances without a rule", () => {
    const current = settings([rule("instance:codex", "c", { instanceId: CODEX_INSTANCE })]);
    const candidates = systemPromptOverrideCandidates(current, [
      provider(CODEX_INSTANCE, "codex"),
      provider(CURSOR_INSTANCE, "cursor"),
      provider(ProviderInstanceId.make("grok"), "grok", false),
    ]);

    expect(candidates.map((entry) => entry.instanceId)).toEqual([CURSOR_INSTANCE]);
  });
});

describe("buildSystemPromptPreview", () => {
  it("renders the composed text per instance and marks unsupported drivers", () => {
    const current = settings([
      rule("global", "Be concise."),
      rule("instance:codex", "Prefer rg.", { instanceId: CODEX_INSTANCE }),
    ]);

    const preview = buildSystemPromptPreview(current, [
      provider(CODEX_INSTANCE, "codex"),
      provider(CURSOR_INSTANCE, "cursor"),
    ]);

    expect(preview).toEqual([
      {
        instanceId: CODEX_INSTANCE,
        driverKind: ProviderDriverKind.make("codex"),
        displayName: CODEX_INSTANCE,
        support: "session",
        text: "Be concise.\n\nPrefer rg.",
      },
      {
        instanceId: CURSOR_INSTANCE,
        driverKind: ProviderDriverKind.make("cursor"),
        displayName: CURSOR_INSTANCE,
        support: "unsupported",
        text: undefined,
      },
    ]);
  });

  it("renders nothing when the master switch is off", () => {
    const current: SystemPromptInjectionSettings = {
      ...settings([rule("global", "Be concise.")]),
      enabled: false,
    };
    const preview = buildSystemPromptPreview(current, [provider(CODEX_INSTANCE, "codex")]);
    expect(preview[0]?.text).toBeUndefined();
  });

  it("skips disabled instances", () => {
    const preview = buildSystemPromptPreview(settings([rule("global", "x")]), [
      provider(CODEX_INSTANCE, "codex", false),
    ]);
    expect(preview).toEqual([]);
  });
});
