import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { autoSwitchThresholdReached, nextAutoSwitchTarget } from "./providerAutoSwitch.ts";

const selection = (instanceId: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model: "model",
});

const provider = (
  instanceId: string,
  usage: { readonly session?: number; readonly weekly?: number } = {},
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-18T00:00:00.000Z",
  models: [{ slug: "model", name: "Model", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: "2026-11-18T00:00:00.000Z",
    windows: (["session", "weekly"] as const).flatMap((kind) =>
      usage[kind] === undefined ? [] : [{ id: kind, kind, label: kind, usedPercent: usage[kind] }],
    ),
  },
  ...overrides,
});

const route = (...ids: ReadonlyArray<string>) => ({
  ...DEFAULT_SERVER_SETTINGS.providerAutoSwitch,
  mode: "route" as const,
  route: ids.map(selection),
});

describe("nextAutoSwitchTarget", () => {
  it("continues after the current provider and wraps around the route", () => {
    const providers = [provider("a"), provider("b"), provider("c")];
    expect(nextAutoSwitchTarget(route("a", "b", "c"), providers, selection("b"))).toEqual(
      selection("c"),
    );
    expect(nextAutoSwitchTarget(route("a", "b", "c"), providers, selection("c"))).toEqual(
      selection("a"),
    );
    expect(nextAutoSwitchTarget(route("a", "b"), providers, selection("z"))).toEqual(
      selection("a"),
    );
  });

  it("skips exhausted, disabled, and missing providers, and never returns the current one", () => {
    const providers = [
      provider("a"),
      provider("b", { weekly: 100 }),
      provider("c", {}, { enabled: false }),
      provider("e"),
    ];
    expect(nextAutoSwitchTarget(route("a", "b", "c", "d", "e"), providers, selection("a"))).toEqual(
      selection("e"),
    );
    expect(nextAutoSwitchTarget(route("a", "b", "c"), providers, selection("a"))).toBeNull();
  });

  it("skips targets already past the threshold so the route does not bounce", () => {
    const settings = { ...route("a", "b", "c"), trigger: "session" as const, thresholdPercent: 80 };
    const providers = [
      provider("a", { session: 85 }),
      provider("b", { session: 90 }),
      provider("c"),
    ];
    expect(autoSwitchThresholdReached(settings, providers, selection("a"))).toBe(true);
    expect(nextAutoSwitchTarget(settings, providers, selection("a"))).toEqual(selection("c"));
  });
});

describe("autoSwitchThresholdReached", () => {
  it("watches only the configured window and ignores providers that report no usage", () => {
    const weekly = { ...route("a"), trigger: "weekly" as const, thresholdPercent: 50 };
    expect(
      autoSwitchThresholdReached(weekly, [provider("a", { session: 99 })], selection("a")),
    ).toBe(false);
    expect(
      autoSwitchThresholdReached(weekly, [provider("a", { weekly: 50 })], selection("a")),
    ).toBe(true);
    expect(
      autoSwitchThresholdReached(route("a"), [provider("a", { weekly: 100 })], selection("a")),
    ).toBe(false);
  });
});
