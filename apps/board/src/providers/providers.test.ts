import { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  canStart,
  defaultPick,
  NO_PICK,
  pickableInstances,
  pickOf,
  resolvePick,
  selectionOf,
} from "./providers";

const decodeProvider = Schema.decodeUnknownSync(ServerProvider);

interface Fixture {
  readonly instanceId: string;
  readonly driver: string;
  readonly status?: "authenticated" | "unauthenticated" | "unknown";
  readonly email?: string;
  readonly installed?: boolean;
  readonly canAuthenticate?: boolean;
  readonly message?: string;
  readonly displayName?: string;
  readonly models?: ReadonlyArray<ModelFixture>;
}

interface ModelFixture {
  readonly slug: string;
  readonly isDefault?: boolean;
  readonly isLegacy?: boolean;
  readonly efforts?: ReadonlyArray<string>;
  readonly defaultEffort?: string;
}

const provider = (fixture: Fixture) =>
  decodeProvider({
    instanceId: fixture.instanceId,
    driver: fixture.driver,
    displayName: fixture.displayName,
    enabled: true,
    installed: fixture.installed ?? true,
    version: null,
    status: "ready",
    auth: { status: fixture.status ?? "authenticated", email: fixture.email },
    setup: { canAuthenticate: fixture.canAuthenticate ?? false, canInstall: false },
    message: fixture.message,
    checkedAt: "2026-11-20T06:00:00.000Z",
    models: (fixture.models ?? []).map(({ efforts, defaultEffort, ...model }) => ({
      name: model.slug,
      isCustom: false,
      capabilities:
        efforts === undefined
          ? null
          : {
              optionDescriptors: [
                {
                  id: "effort",
                  label: "Effort",
                  type: "select",
                  options: efforts.map((id) => ({
                    id,
                    label: id,
                    ...(id === defaultEffort ? { isDefault: true } : {}),
                  })),
                },
              ],
            },
      ...model,
    })),
  });

describe("the provider picker's instances", () => {
  it("Given Codex, Cursor, and Claude Code, when they are listed, then Claude Code leads and Cursor is left out", () => {
    const listed = pickableInstances([
      provider({ instanceId: "codex", driver: "codex" }),
      provider({ instanceId: "cursor", driver: "cursor" }),
      provider({ instanceId: "claudeAgent", driver: "claudeAgent", displayName: "Claude" }),
    ]);
    expect(listed.map((instance) => [instance.instanceId, instance.name])).toEqual([
      ["claudeAgent", "Claude Code"],
      ["codex", "Codex"],
    ]);
  });

  it("Given a custom Claude instance named before the default, when they are listed, then the default still leads", () => {
    const listed = pickableInstances([
      provider({ instanceId: "claude_alt", driver: "claudeAgent", displayName: "Claude alt" }),
      provider({ instanceId: "claudeAgent", driver: "claudeAgent" }),
    ]);
    expect(listed.map((instance) => instance.name)).toEqual(["Claude Code", "Claude alt"]);
  });

  it("Given models with a default and a legacy one, when they are listed, then the legacy one is dropped and the default is named", () => {
    const [listed] = pickableInstances([
      provider({
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        models: [
          { slug: "claude-old", isLegacy: true },
          { slug: "claude-sonnet-5-5" },
          { slug: "claude-opus-5-5", isDefault: true },
        ],
      }),
    ]);
    expect(listed?.models.map((model) => model.slug)).toEqual([
      "claude-sonnet-5-5",
      "claude-opus-5-5",
    ]);
    expect(listed?.defaultModel).toBe("claude-opus-5-5");
  });

  it("Given a signed-out managed Codex and a signed-in Claude Code, when they are listed, then each shows its sign-in state and account", () => {
    const listed = pickableInstances([
      provider({ instanceId: "claudeAgent", driver: "claudeAgent", email: "me@example.com" }),
      provider({
        instanceId: "codex_managed",
        driver: "codex",
        status: "unauthenticated",
        canAuthenticate: true,
        displayName: "Codex managed",
      }),
    ]);
    expect(
      listed.map((instance) => [instance.signIn, instance.account, instance.canSignIn]),
    ).toEqual([
      ["signed-in", "me@example.com", false],
      ["signed-out", null, true],
    ]);
    expect(listed.map(canStart)).toEqual([true, false]);
  });

  it("Given a signed-out Claude instance, when it is listed, then the engine's sign-in instructions come with it", () => {
    const [listed] = pickableInstances([
      provider({
        instanceId: "claude_alt",
        driver: "claudeAgent",
        status: "unauthenticated",
        message: "Run `claude auth login` on this machine.",
      }),
    ]);
    expect(listed?.message).toBe("Run `claude auth login` on this machine.");
  });

  it("Given an instance that is not installed, when it is listed, then it cannot start an orchestrator", () => {
    const [listed] = pickableInstances([
      provider({ instanceId: "codex", driver: "codex", installed: false }),
    ]);
    expect(listed?.unavailable).toBe("Not installed on the machine that runs T3");
    expect(listed === undefined || canStart(listed)).toBe(false);
  });
});

describe("the orchestrator's pick", () => {
  const claude = (
    status: "authenticated" | "unauthenticated",
    models: ReadonlyArray<ModelFixture> = CLAUDE_MODELS,
  ) => provider({ instanceId: "claudeAgent", driver: "claudeAgent", status, models });
  const codex = provider({
    instanceId: "codex",
    driver: "codex",
    models: [
      {
        slug: "gpt-5.6-terra",
        isDefault: true,
        efforts: ["low", "medium"],
        defaultEffort: "medium",
      },
      { slug: "gpt-6-luna" },
    ],
  });
  const CLAUDE_MODELS = [
    {
      slug: "claude-opus-5-5",
      isDefault: true,
      efforts: ["low", "medium", "high"],
      defaultEffort: "medium",
    },
    { slug: "claude-sonnet-5-5", efforts: ["low", "medium", "high"], defaultEffort: "high" },
  ];

  it("Given a signed-in Claude Code that offers Opus 5.5, when nothing is picked, then it starts on Opus 5.5 at medium with no reason", () => {
    const instances = pickableInstances([codex, claude("authenticated")]);
    expect(defaultPick(instances)).toEqual({
      value: { instanceId: "claudeAgent", model: "claude-opus-5-5", effort: "medium" },
      reason: null,
    });
  });

  it("Given a signed-out Claude Code, when nothing is picked, then the first signed-in instance and its default model start, with the reason", () => {
    const instances = pickableInstances([claude("unauthenticated"), codex]);
    expect(defaultPick(instances)).toEqual({
      value: { instanceId: "codex", model: "gpt-5.6-terra", effort: "" },
      reason: "Claude Code is signed out. Starting on Codex instead.",
    });
  });

  it("Given a signed-in Claude Code without Opus 5.5, when nothing is picked, then the reason names the missing model", () => {
    const instances = pickableInstances([
      claude("authenticated", [{ slug: "claude-sonnet-5-5", isDefault: true }]),
      codex,
    ]);
    expect(defaultPick(instances).reason).toBe(
      "Claude Code does not offer claude-opus-5-5. Starting on Claude Code instead.",
    );
  });

  it("Given no Claude Code instance, when nothing is picked, then the reason says the engine has none", () => {
    expect(defaultPick(pickableInstances([codex])).reason).toBe(
      "The engine has no Claude Code instance. Starting on Codex instead.",
    );
  });

  it("Given an Opus 5.5 whose effort levels lack medium, when nothing is picked, then the model's own default effort is used", () => {
    const instances = pickableInstances([
      claude("authenticated", [{ slug: "claude-opus-5-5", efforts: ["low", "high"] }]),
    ]);
    expect(defaultPick(instances).value.effort).toBe("");
  });

  it("Given a model typed before any pick, when the pick resolves, then the typed model is kept on the default instance", () => {
    const instances = pickableInstances([codex, claude("unauthenticated")]);
    expect(resolvePick(instances, { ...NO_PICK, model: "gpt-6-luna" })).toEqual({
      instanceId: "codex",
      model: "gpt-6-luna",
      effort: "",
    });
  });

  it("Given a pick, when it resolves, then the pick stands", () => {
    const instances = pickableInstances([claude("authenticated")]);
    const pick = { instanceId: "claudeAgent", model: "claude-sonnet-5-5", effort: "low" };
    expect(resolvePick(instances, pick)).toBe(pick);
  });

  it("Given a picked effort, when the selection is made, then the model selection carries it under the model's effort option", () => {
    const instances = pickableInstances([claude("authenticated")]);
    expect(
      selectionOf(instances, {
        instanceId: "claudeAgent",
        model: "claude-opus-5-5",
        effort: "medium",
      }),
    ).toEqual({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      model: "claude-opus-5-5",
      offered: ["claude-opus-5-5", "claude-sonnet-5-5"],
      options: [{ id: "effort", value: "medium" }],
    });
  });

  it("Given a typed model the instance does not list, when the selection is made, then the typed model is used with the offered list and no options", () => {
    const instances = pickableInstances([codex]);
    expect(
      selectionOf(instances, { instanceId: "codex", model: " gpt-nope ", effort: "high" }),
    ).toEqual({
      instanceId: "codex",
      driver: "codex",
      model: "gpt-nope",
      offered: ["gpt-5.6-terra", "gpt-6-luna"],
      options: [],
    });
  });

  it("Given an empty model, when the selection is made, then the instance's default is used", () => {
    const instances = pickableInstances([codex]);
    expect(selectionOf(instances, { instanceId: "codex", model: "", effort: "" })?.model).toBe(
      "gpt-5.6-terra",
    );
  });

  it("Given a thread's model selection, when it fills the picker, then the effort is the one the selection carries", () => {
    const instances = pickableInstances([claude("authenticated")]);
    expect(
      pickOf(instances, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-5-5",
        options: [{ id: "effort", value: "low" }],
      }),
    ).toEqual({ instanceId: "claudeAgent", model: "claude-sonnet-5-5", effort: "low" });
  });
});
