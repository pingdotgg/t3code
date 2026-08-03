import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  composeSystemPromptText,
  resolveSystemPromptInjection,
  selectSystemPromptRules,
  SystemPromptInjectionSettings,
  systemPromptInjectionSupport,
  type SystemPromptRule,
  type SystemPromptTarget,
} from "./systemPrompt.ts";

const decodeSettings = Schema.decodeUnknownSync(SystemPromptInjectionSettings);
const encodeSettings = Schema.encodeSync(SystemPromptInjectionSettings);

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CODEX_INSTANCE = ProviderInstanceId.make("codex");
const CODEX_WORK_INSTANCE = ProviderInstanceId.make("codex-work");

const target = (overrides?: Partial<SystemPromptTarget>): SystemPromptTarget => ({
  driverKind: CODEX,
  instanceId: CODEX_INSTANCE,
  ...overrides,
});

const rule = (overrides: Partial<SystemPromptRule> & { readonly id: string }): SystemPromptRule =>
  decodeSettings({ rules: [{ text: "", ...overrides }] }).rules[0]!;

const settings = (rules: ReadonlyArray<SystemPromptRule>, enabled = true) =>
  decodeSettings({ enabled, rules: encodeSettings({ schemaVersion: 1, enabled, rules }).rules });

describe("composeSystemPromptText", () => {
  it("joins segments with a blank line", () => {
    expect(composeSystemPromptText(["first", "second"])).toBe("first\n\nsecond");
  });

  it("skips empty and whitespace-only segments", () => {
    expect(composeSystemPromptText(["first", "", "   ", undefined, "second"])).toBe(
      "first\n\nsecond",
    );
  });

  it("returns undefined when every segment is empty", () => {
    expect(composeSystemPromptText(["", "   ", undefined])).toBeUndefined();
  });

  it("leaves a single segment unchanged", () => {
    expect(composeSystemPromptText(["only one"])).toBe("only one");
  });
});

describe("selectSystemPromptRules", () => {
  it("preserves declaration order", () => {
    const selected = selectSystemPromptRules(
      settings([rule({ id: "a", text: "a" }), rule({ id: "b", text: "b" })]),
      target(),
    );
    expect(selected.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("drops disabled rules", () => {
    const selected = selectSystemPromptRules(
      settings([rule({ id: "a", text: "a", enabled: false }), rule({ id: "b", text: "b" })]),
      target(),
    );
    expect(selected.map((entry) => entry.id)).toEqual(["b"]);
  });

  it("treats an empty match as global", () => {
    const global = rule({ id: "global", text: "everywhere" });
    expect(selectSystemPromptRules(settings([global]), target()).length).toBe(1);
    expect(
      selectSystemPromptRules(
        settings([global]),
        target({ driverKind: CLAUDE, instanceId: ProviderInstanceId.make("claudeAgent") }),
      ).length,
    ).toBe(1);
  });

  it("narrows on each constraint", () => {
    const byDriver = rule({ id: "driver", text: "d", match: { driverKind: CLAUDE } });
    const byInstance = rule({
      id: "instance",
      text: "i",
      match: { instanceId: CODEX_WORK_INSTANCE },
    });
    const byMode = rule({ id: "mode", text: "m", match: { interactionMode: "plan" } });
    const all = settings([byDriver, byInstance, byMode]);

    expect(selectSystemPromptRules(all, target()).map((entry) => entry.id)).toEqual([]);
    expect(
      selectSystemPromptRules(all, target({ driverKind: CLAUDE })).map((entry) => entry.id),
    ).toEqual(["driver"]);
    expect(
      selectSystemPromptRules(all, target({ instanceId: CODEX_WORK_INSTANCE })).map(
        (entry) => entry.id,
      ),
    ).toEqual(["instance"]);
    expect(
      selectSystemPromptRules(all, target({ interactionMode: "plan" })).map((entry) => entry.id),
    ).toEqual(["mode"]);
  });

  it("requires every constraint of a two-constraint rule", () => {
    const both = settings([
      rule({
        id: "both",
        text: "b",
        match: { driverKind: CODEX, instanceId: CODEX_WORK_INSTANCE },
      }),
    ]);
    expect(selectSystemPromptRules(both, target()).length).toBe(0);
    expect(selectSystemPromptRules(both, target({ instanceId: CODEX_WORK_INSTANCE })).length).toBe(
      1,
    );
    expect(
      selectSystemPromptRules(both, target({ driverKind: CLAUDE, instanceId: CODEX_WORK_INSTANCE }))
        .length,
    ).toBe(0);
  });

  it("globs the model slug", () => {
    const prefix = settings([rule({ id: "gpt", text: "g", match: { modelSlug: "gpt-*" } })]);
    expect(selectSystemPromptRules(prefix, target({ modelSlug: "gpt-5.3-codex" })).length).toBe(1);
    expect(selectSystemPromptRules(prefix, target({ modelSlug: "opus-5" })).length).toBe(0);
    expect(selectSystemPromptRules(prefix, target()).length).toBe(0);

    const any = settings([rule({ id: "any", text: "a", match: { modelSlug: "*" } })]);
    expect(selectSystemPromptRules(any, target({ modelSlug: "anything" })).length).toBe(1);

    const exact = settings([rule({ id: "exact", text: "e", match: { modelSlug: "opus-5" } })]);
    expect(selectSystemPromptRules(exact, target({ modelSlug: "opus-5" })).length).toBe(1);
    expect(selectSystemPromptRules(exact, target({ modelSlug: "opus-5-mini" })).length).toBe(0);
  });

  it("does not let a glob metacharacter in the pattern leak into the regex", () => {
    const dotted = settings([rule({ id: "dot", text: "d", match: { modelSlug: "gpt-5.3" } })]);
    expect(selectSystemPromptRules(dotted, target({ modelSlug: "gpt-5.3" })).length).toBe(1);
    expect(selectSystemPromptRules(dotted, target({ modelSlug: "gpt-543" })).length).toBe(0);
  });
});

describe("resolveSystemPromptInjection", () => {
  it("composes the matching rules in order", () => {
    const resolved = resolveSystemPromptInjection(
      settings([
        rule({ id: "global", text: "Be concise." }),
        rule({ id: "codex", text: "Prefer rg.", match: { driverKind: CODEX } }),
        rule({ id: "claude", text: "Never used.", match: { driverKind: CLAUDE } }),
      ]),
      target(),
    );
    expect(resolved).toBe("Be concise.\n\nPrefer rg.");
  });

  it("returns undefined when the master switch is off", () => {
    expect(
      resolveSystemPromptInjection(
        settings([rule({ id: "global", text: "Be concise." })], false),
        target(),
      ),
    ).toBeUndefined();
  });

  it("returns undefined when nothing matches", () => {
    expect(
      resolveSystemPromptInjection(
        settings([rule({ id: "claude", text: "x", match: { driverKind: CLAUDE } })]),
        target(),
      ),
    ).toBeUndefined();
  });
});

describe("SystemPromptInjectionSettings schema", () => {
  it("decodes an empty object to enabled with no rules", () => {
    expect(decodeSettings({})).toEqual({ schemaVersion: 1, enabled: true, rules: [] });
  });

  it("defaults a rule to enabled with an empty match", () => {
    const decoded = decodeSettings({ rules: [{ id: "a", text: "hello" }] });
    expect(decoded.rules[0]).toEqual({ id: "a", enabled: true, match: {}, text: "hello" });
  });

  it("round-trips a fully specified rule", () => {
    const encoded = {
      schemaVersion: 1,
      enabled: true,
      rules: [
        {
          id: "a",
          enabled: false,
          match: { driverKind: "codex", instanceId: "codex-work", modelSlug: "gpt-*" },
          text: "hello",
        },
      ],
    };
    expect(encodeSettings(decodeSettings(encoded))).toEqual(encoded);
  });
});

describe("systemPromptInjectionSupport", () => {
  it("mirrors the adapter capabilities", () => {
    expect(systemPromptInjectionSupport("claudeAgent")).toBe("session");
    expect(systemPromptInjectionSupport("codex")).toBe("session");
    expect(systemPromptInjectionSupport("cursor")).toBe("unsupported");
    expect(systemPromptInjectionSupport("grok")).toBe("unsupported");
    expect(systemPromptInjectionSupport("opencode")).toBe("unsupported");
  });

  it("reads an unknown driver as unsupported", () => {
    expect(systemPromptInjectionSupport("some-fork-driver")).toBe("unsupported");
  });
});
