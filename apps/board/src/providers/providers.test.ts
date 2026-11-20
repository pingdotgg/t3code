import { ServerProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { canStart, NO_PICK, pickableInstances, resolvePick, selectionOf } from "./providers";

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
  readonly models?: ReadonlyArray<{
    readonly slug: string;
    readonly isDefault?: boolean;
    readonly isLegacy?: boolean;
  }>;
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
    models: (fixture.models ?? []).map((model) => ({
      name: model.slug,
      isCustom: false,
      capabilities: null,
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
  const instances = pickableInstances([
    provider({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      status: "unauthenticated",
      models: [{ slug: "claude-opus-5-5", isDefault: true }],
    }),
    provider({
      instanceId: "codex",
      driver: "codex",
      models: [{ slug: "gpt-5.6-terra", isDefault: true }, { slug: "gpt-6-luna" }],
    }),
  ]);

  it("Given nothing picked and the first instance signed out, when the pick resolves, then it falls to the first that can start", () => {
    expect(resolvePick(instances, NO_PICK)).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-terra",
    });
  });

  it("Given a model typed before any pick, when the pick resolves, then the typed model is kept", () => {
    expect(resolvePick(instances, { instanceId: "", model: "gpt-6-luna" })).toEqual({
      instanceId: "codex",
      model: "gpt-6-luna",
    });
  });

  it("Given a pick, when it resolves, then the pick stands", () => {
    const pick = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
    expect(resolvePick(instances, pick)).toBe(pick);
  });

  it("Given a typed model the instance does not list, when the selection is made, then the typed model is used with the offered list", () => {
    expect(selectionOf(instances, { instanceId: "codex", model: " gpt-nope " })).toEqual({
      instanceId: "codex",
      driver: "codex",
      model: "gpt-nope",
      offered: ["gpt-5.6-terra", "gpt-6-luna"],
    });
  });

  it("Given an empty model, when the selection is made, then the instance's default is used", () => {
    expect(selectionOf(instances, { instanceId: "codex", model: "" })?.model).toBe("gpt-5.6-terra");
  });
});
