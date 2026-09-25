import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { describe, expect, it } from "vite-plus/test";
import { planPrismModelsPatch } from "./PrismSettings.logic";
import { createPrismSaveStore } from "./PrismSettings.state";
import { resolveSettingsScope } from "./settingsScope";

const environment = {
  environmentId: EnvironmentId.make("one"),
  label: "one",
  connection: { phase: "connected" as const },
  serverConfig: { settings: DEFAULT_SERVER_SETTINGS },
};
const models = [{ instanceId: ProviderInstanceId.make("codex"), model: "model", effort: "high" }];
const expectation = {
  kind: "lane" as const,
  role: "worker" as const,
  lane: "easy" as const,
  models,
};
const scope = resolveSettingsScope({}, [], [environment]);
const plan = planPrismModelsPatch(scope, [environment], "worker", "easy", models);
const updatedEnvironment = {
  ...environment,
  serverConfig: {
    settings: applyServerSettingsPatch(
      environment.serverConfig.settings,
      plan.serverWrites[0]!.patch,
    ),
  },
};

describe("Prism save lifecycle", () => {
  it("retains the guard without page subscribers until acknowledgement and fresh settings arrive", () => {
    const store = createPrismSaveStore();
    const unsubscribe = store.subscribe(() => {});
    expect(store.getState().begin(plan, expectation)).toBe(true);
    unsubscribe(); // Scope navigation unmounts the editor while its RPC is outstanding.
    expect(store.getState().begin(plan, expectation)).toBe(false);
    store.getState().observe([updatedEnvironment]);
    expect(store.getState().pendingWrite).not.toBeNull(); // Stream may arrive before the receipt.
    store.getState().acknowledge(new Set());
    store.getState().observe([environment]);
    expect(store.getState().begin(plan, expectation)).toBe(false); // Receipt alone cannot release stale data.
    store.getState().observe([updatedEnvironment]);
    expect(store.getState().pendingWrite).toBeNull();
    const next = planPrismModelsPatch(scope, [updatedEnvironment], "worker", "hard", models);
    expect(store.getState().begin(next, { ...expectation, lane: "hard" })).toBe(true);
    const settings = applyServerSettingsPatch(
      updatedEnvironment.serverConfig.settings,
      next.serverWrites[0]!.patch,
    );
    expect(settings.prismRoles.worker.lanes.easy).toEqual(models);
    expect(settings.prismRoles.worker.lanes.hard).toEqual(models);
  });

  it("releases failed writes without expecting nonexistent snapshots and retains their error", () => {
    const store = createPrismSaveStore();
    store.getState().begin(plan, expectation);
    store.getState().acknowledge(new Set([environment.environmentId]));
    store.getState().setSaveError("one failed");
    store.getState().observe([environment]);
    expect(store.getState().pendingWrite).toBeNull();
    expect(store.getState().saveError).toBe("one failed");
    expect(store.getState().begin(plan, expectation)).toBe(true);
    expect(store.getState().saveError).toBeNull();
    store.getState().fail("Connection lost");
    expect(store.getState().pendingWrite).toBeNull();
    expect(store.getState().saveError).toBe("Connection lost");
  });
});
