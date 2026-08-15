import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  advancePlanModePreferenceReconciliationKey,
  createPlanModePreferenceReconciliationKey,
  createPlanModePreferenceWrite,
  createSyncedClientPreferenceReconciliationController,
  createSyncedClientPreferenceWriteController,
  createSyncedClientPreferencesWrite,
  hasPlanModePreferenceReconciliationAttempted,
  isPlanModePreferenceReconciliationReady,
  nextMobileSyncedPreferencesUpdatedAt,
  reconcilePlanModePreferences,
  reconcileSyncedClientPreferences,
} from "./synced-client-preferences-model";

const environmentId = (value: string) => EnvironmentId.make(value);
const livePlanModeEnvironment = (id: string, value: boolean, updatedAt: string) => ({
  environmentId: environmentId(id),
  connectionState: "connected" as const,
  shellStatus: "live" as const,
  preferences: { planModeEnabled: value, updatedAt },
});

describe("synced client preferences", () => {
  const flushReconciliation = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  const makeRetryScheduler = () => {
    const scheduled: Array<{
      readonly delayMs: number;
      readonly run: () => void;
      readonly cancelled: () => boolean;
    }> = [];
    const schedule = (retry: () => void, delayMs: number) => {
      let cancelled = false;
      scheduled.push({
        delayMs,
        run: () => {
          if (!cancelled) retry();
        },
        cancelled: () => cancelled,
      });
      return () => {
        cancelled = true;
      };
    };
    return { schedule, scheduled };
  };

  it("uses the device preference immediately when the loaded catalog has no environments", () => {
    expect(
      isPlanModePreferenceReconciliationReady({
        connectionsLoaded: true,
        environmentCount: 0,
        currentKey: "[]",
        appliedKey: null,
      }),
    ).toBe(true);
  });

  it("waits for catalog hydration before applying the no-environment fallback", () => {
    expect(
      isPlanModePreferenceReconciliationReady({
        connectionsLoaded: false,
        environmentCount: 0,
        currentKey: "[]",
        appliedKey: null,
      }),
    ).toBe(false);
  });

  it("waits for an environment reconciliation to apply", () => {
    expect(
      isPlanModePreferenceReconciliationReady({
        connectionsLoaded: true,
        environmentCount: 1,
        currentKey: "current",
        appliedKey: null,
      }),
    ).toBe(false);
  });

  it("opens gating after the current environment reconciliation applies", () => {
    const currentKey = createPlanModePreferenceReconciliationKey([
      livePlanModeEnvironment("environment-1", true, "2026-08-14T12:00:00.000Z"),
    ]);

    expect(
      isPlanModePreferenceReconciliationReady({
        connectionsLoaded: true,
        environmentCount: 1,
        currentKey,
        appliedKey: currentKey,
      }),
    ).toBe(true);
  });

  it("keeps send gating open while an unrelated environment reconnects", () => {
    const liveEnvironment = {
      environmentId: environmentId("live"),
      connectionState: "connected",
      shellStatus: "live",
      preferences: {
        planModeEnabled: true,
        updatedAt: "2026-08-14T12:00:00.000Z",
      },
    } as const;
    const connectingKey = createPlanModePreferenceReconciliationKey([
      liveEnvironment,
      {
        environmentId: environmentId("flapping"),
        connectionState: "connecting",
        shellStatus: "cached",
        preferences: undefined,
      },
    ]);
    const reconnectingKey = createPlanModePreferenceReconciliationKey([
      liveEnvironment,
      {
        environmentId: environmentId("flapping"),
        connectionState: "reconnecting",
        shellStatus: "cached",
        preferences: undefined,
      },
    ]);

    expect(
      hasPlanModePreferenceReconciliationAttempted([
        liveEnvironment,
        { connectionState: "reconnecting", shellStatus: "cached" },
      ]),
    ).toBe(true);
    expect(
      isPlanModePreferenceReconciliationReady({
        connectionsLoaded: true,
        environmentCount: 2,
        currentKey: reconnectingKey,
        appliedKey: connectingKey,
      }),
    ).toBe(true);
  });

  it("keeps the applied reconciliation state when an offline environment leaves", () => {
    const remainingOfflineEnvironment = {
      environmentId: environmentId("remaining-offline"),
      connectionState: "offline",
      shellStatus: "cached",
      preferences: undefined,
    } as const;
    const offlineKey = createPlanModePreferenceReconciliationKey([
      {
        environmentId: environmentId("offline"),
        connectionState: "offline",
        shellStatus: "cached",
        preferences: undefined,
      },
      remainingOfflineEnvironment,
    ]);
    const remainingKey = createPlanModePreferenceReconciliationKey([remainingOfflineEnvironment]);

    expect(
      isPlanModePreferenceReconciliationReady({
        connectionsLoaded: true,
        environmentCount: 1,
        currentKey: remainingKey,
        appliedKey: offlineKey,
      }),
    ).toBe(true);
    expect(advancePlanModePreferenceReconciliationKey(offlineKey, remainingKey)).toBe(offlineKey);
  });

  it("does not accept a stale live shell while its environment is reconnecting", () => {
    expect(
      hasPlanModePreferenceReconciliationAttempted([
        { connectionState: "reconnecting", shellStatus: "live" },
      ]),
    ).toBe(false);
  });

  it("uses the device fallback after the first offline reconciliation attempt", () => {
    const offlineState = {
      environmentId: environmentId("offline"),
      connectionState: "offline",
      shellStatus: "cached",
      preferences: undefined,
    } as const;
    const offlineKey = createPlanModePreferenceReconciliationKey([offlineState]);

    expect(hasPlanModePreferenceReconciliationAttempted([offlineState])).toBe(true);
    expect(
      isPlanModePreferenceReconciliationReady({
        connectionsLoaded: true,
        environmentCount: 1,
        currentKey: offlineKey,
        appliedKey: null,
      }),
    ).toBe(false);
    expect(
      isPlanModePreferenceReconciliationReady({
        connectionsLoaded: true,
        environmentCount: 1,
        currentKey: offlineKey,
        appliedKey: offlineKey,
      }),
    ).toBe(true);
  });

  it("reconciles a newly live newer preference without blocking reconnect churn", () => {
    const environment = {
      environmentId: environmentId("environment-1"),
      shellStatus: "cached",
      preferences: undefined,
    } as const;
    const offlineKey = createPlanModePreferenceReconciliationKey([
      { ...environment, connectionState: "offline" },
    ]);
    const connectingKey = createPlanModePreferenceReconciliationKey([
      { ...environment, connectionState: "connecting" },
    ]);
    const reconnectingKey = createPlanModePreferenceReconciliationKey([
      { ...environment, connectionState: "reconnecting" },
    ]);
    const liveKey = createPlanModePreferenceReconciliationKey([
      {
        ...environment,
        connectionState: "connected",
        shellStatus: "live",
        preferences: {
          planModeEnabled: true,
          updatedAt: "2026-08-14T12:00:00.000Z",
        },
      },
    ]);

    expect(connectingKey).toBe(reconnectingKey);
    expect(connectingKey).toBe(offlineKey);
    expect(
      isPlanModePreferenceReconciliationReady({
        connectionsLoaded: true,
        environmentCount: 1,
        currentKey: reconnectingKey,
        appliedKey: offlineKey,
      }),
    ).toBe(true);
    expect(liveKey).not.toBe(offlineKey);
    expect(
      isPlanModePreferenceReconciliationReady({
        connectionsLoaded: true,
        environmentCount: 1,
        currentKey: liveKey,
        appliedKey: offlineKey,
      }),
    ).toBe(false);
    expect(
      isPlanModePreferenceReconciliationReady({
        connectionsLoaded: true,
        environmentCount: 1,
        currentKey: liveKey,
        appliedKey: advancePlanModePreferenceReconciliationKey(offlineKey, liveKey),
      }),
    ).toBe(true);
  });

  it("keeps gating open for a newly live preference older than the applied watermark", () => {
    const currentKey = createPlanModePreferenceReconciliationKey([
      livePlanModeEnvironment("older", false, "2026-08-14T12:00:00.000Z"),
    ]);
    const appliedKey = createPlanModePreferenceReconciliationKey([
      livePlanModeEnvironment("newer", true, "2026-08-14T12:01:00.000Z"),
    ]);

    expect(
      isPlanModePreferenceReconciliationReady({
        connectionsLoaded: true,
        environmentCount: 1,
        currentKey,
        appliedKey,
      }),
    ).toBe(true);
  });

  it("reconciles a newly live equal-stamp winner with a different value", () => {
    const updatedAt = "2026-08-14T12:00:00.000Z";
    const initialEnvironment = livePlanModeEnvironment("environment-1", false, updatedAt);
    const appliedKey = createPlanModePreferenceReconciliationKey([initialEnvironment]);
    const currentKey = createPlanModePreferenceReconciliationKey([
      initialEnvironment,
      livePlanModeEnvironment("environment-2", true, updatedAt),
    ]);

    expect(
      isPlanModePreferenceReconciliationReady({
        connectionsLoaded: true,
        environmentCount: 2,
        currentKey,
        appliedKey,
      }),
    ).toBe(false);
    expect(
      isPlanModePreferenceReconciliationReady({
        connectionsLoaded: true,
        environmentCount: 2,
        currentKey,
        appliedKey: advancePlanModePreferenceReconciliationKey(appliedKey, currentKey),
      }),
    ).toBe(true);
  });

  it("keeps gating open for a newly live equal-stamp winner with the same value", () => {
    const updatedAt = "2026-08-14T12:00:00.000Z";
    const initialEnvironment = livePlanModeEnvironment("environment-1", false, updatedAt);
    const appliedKey = createPlanModePreferenceReconciliationKey([initialEnvironment]);
    const currentKey = createPlanModePreferenceReconciliationKey([
      initialEnvironment,
      livePlanModeEnvironment("environment-2", false, updatedAt),
    ]);

    expect(
      isPlanModePreferenceReconciliationReady({
        connectionsLoaded: true,
        environmentCount: 2,
        currentKey,
        appliedKey,
      }),
    ).toBe(true);
  });

  it("bounds excessively future-skewed local stamps", () => {
    expect(
      nextMobileSyncedPreferencesUpdatedAt(
        ["2026-08-14T12:05:00.001Z"],
        "2026-08-14T12:00:00.000Z",
      ),
    ).toBe("2026-08-14T12:00:00.000Z");
    expect(
      nextMobileSyncedPreferencesUpdatedAt(
        ["2026-08-14T12:05:00.000Z"],
        "2026-08-14T12:00:00.000Z",
      ),
    ).toBe("2026-08-14T12:05:00.001Z");
  });

  it("advances past authoritative environment stamps on a slow device clock", () => {
    expect(
      nextMobileSyncedPreferencesUpdatedAt([], "2026-08-14T12:00:00.000Z", [
        "2026-08-14T13:00:00.000Z",
      ]),
    ).toBe("2026-08-14T13:00:00.001Z");
  });

  it("adopts the environment plan mode into the device cache on connect", () => {
    expect(
      reconcilePlanModePreferences({
        localPlanModeEnabled: false,
        localUpdatedAt: "2026-08-14T11:00:00.000Z",
        environments: [
          {
            environmentId: environmentId("environment-1"),
            preferences: {
              planModeEnabled: true,
              updatedAt: "2026-08-14T12:00:00.000Z",
            },
          },
        ],
        now: "2026-08-14T12:01:00.000Z",
      }),
    ).toEqual({
      localPatch: {
        planModeEnabled: true,
        syncedClientPreferencesUpdatedAtByField: {
          planModeEnabled: "2026-08-14T12:00:00.000Z",
        },
      },
      environmentPatches: [],
    });
  });

  it("keeps a stamped device preference when a newer environment is read-only", () => {
    expect(
      reconcilePlanModePreferences({
        localPlanModeEnabled: false,
        localUpdatedAt: "2026-08-14T11:00:00.000Z",
        environments: [
          {
            environmentId: environmentId("read-only"),
            canPatch: false,
            preferences: {
              planModeEnabled: true,
              updatedAt: "2026-08-14T12:00:00.000Z",
            },
          },
        ],
        now: "2026-08-14T12:01:00.000Z",
      }),
    ).toEqual({ localPatch: null, environmentPatches: [] });
  });

  it("fans a mobile toggle out to every connected environment", () => {
    const write = createPlanModePreferenceWrite({
      value: true,
      connectedEnvironmentIds: [environmentId("environment-1"), environmentId("environment-2")],
      currentUpdatedAtByField: { planModeEnabled: "2026-08-14T12:00:00.000Z" },
      authoritativePreferences: [
        {
          planModeEnabled: false,
          updatedAt: "2026-08-14T12:02:00.000Z",
        },
      ],
      now: "2026-08-14T12:01:00.000Z",
    });

    expect(write.localPatch).toEqual({
      planModeEnabled: true,
      syncedClientPreferencesUpdatedAtByField: {
        planModeEnabled: "2026-08-14T12:02:00.001Z",
      },
    });
    expect(write.environmentPatches).toEqual([
      {
        environmentId: environmentId("environment-1"),
        input: {
          patch: { planModeEnabled: true },
          updatedAt: "2026-08-14T12:02:00.001Z",
        },
      },
      {
        environmentId: environmentId("environment-2"),
        input: {
          patch: { planModeEnabled: true },
          updatedAt: "2026-08-14T12:02:00.001Z",
        },
      },
    ]);
  });

  it("ignores a stale toggle ack after a newer same-millisecond write", () => {
    const controller = createSyncedClientPreferenceWriteController("planModeEnabled");
    const environment = environmentId("environment-1");
    const first = controller.create({
      patch: { planModeEnabled: true },
      connectedEnvironmentIds: [environment],
      now: "2026-08-14T12:00:00.000Z",
    });
    const second = controller.create({
      patch: { planModeEnabled: false },
      connectedEnvironmentIds: [environment],
      now: "2026-08-14T12:00:00.000Z",
    });

    expect(second.localPatch.updatedAtByField.planModeEnabled).toBe("2026-08-14T12:00:00.001Z");
    expect(
      controller.settle({
        target: second.environmentPatches[0]!,
        result: AsyncResult.success({
          planModeEnabled: false,
          updatedAt: second.environmentPatches[0]!.input.updatedAt,
        }),
      }),
    ).toEqual({
      planModeEnabled: false,
      syncedClientPreferencesUpdatedAtByField: second.localPatch.updatedAtByField,
    });
    expect(
      controller.settle({
        target: first.environmentPatches[0]!,
        result: AsyncResult.success({
          planModeEnabled: true,
          updatedAt: first.environmentPatches[0]!.input.updatedAt,
        }),
      }),
    ).toBeNull();
  });

  it("advances past a local clock reconciled after the previous write", () => {
    const controller = createSyncedClientPreferenceWriteController("planModeEnabled");
    const environment = environmentId("environment-1");
    controller.create({
      patch: { planModeEnabled: true },
      connectedEnvironmentIds: [environment],
      now: "2026-08-14T12:00:00.000Z",
    });

    const write = controller.create({
      patch: { planModeEnabled: false },
      connectedEnvironmentIds: [environment],
      currentUpdatedAtByField: { planModeEnabled: "2026-08-14T12:05:00.000Z" },
      now: "2026-08-14T12:01:00.000Z",
    });

    expect(write.localPatch.updatedAtByField.planModeEnabled).toBe("2026-08-14T12:05:00.001Z");
  });

  it("settles a multi-environment toggle from only the first response", () => {
    const controller = createSyncedClientPreferenceWriteController("planModeEnabled");
    const write = controller.create({
      patch: { planModeEnabled: true },
      connectedEnvironmentIds: [environmentId("environment-1"), environmentId("environment-2")],
      now: "2026-08-14T12:00:00.000Z",
    });

    expect(
      controller.settle({
        target: write.environmentPatches[1]!,
        result: AsyncResult.success({
          planModeEnabled: true,
          updatedAt: "2026-08-14T12:01:00.000Z",
        }),
      }),
    ).toEqual({
      planModeEnabled: true,
      syncedClientPreferencesUpdatedAtByField: {
        planModeEnabled: "2026-08-14T12:01:00.000Z",
      },
    });
    expect(
      controller.settle({
        target: write.environmentPatches[0]!,
        result: AsyncResult.success({
          planModeEnabled: false,
          updatedAt: "2026-08-14T11:59:00.000Z",
        }),
      }),
    ).toBeNull();
  });

  it("normalizes a theme acknowledgment without changing other field stamps", () => {
    const controller = createSyncedClientPreferenceWriteController("themeId");
    const write = controller.create({
      patch: { themeId: "custom-theme" },
      connectedEnvironmentIds: [environmentId("environment-1")],
      currentUpdatedAtByField: {
        appearanceMode: "2026-08-14T11:00:00.000Z",
      },
      now: "2026-08-14T12:00:00.000Z",
    });

    expect(
      controller.settle({
        target: write.environmentPatches[0]!,
        result: AsyncResult.success({
          themeId: "unknown-on-this-device",
          updatedAtByField: { themeId: "2026-08-14T12:01:00.000Z" },
          updatedAt: "2026-08-14T12:01:00.000Z",
        }),
        normalizeThemeId: () => "t3-code",
      }),
    ).toEqual({
      themeId: "t3-code",
      syncedClientPreferencesUpdatedAtByField: {
        themeId: "2026-08-14T12:01:00.000Z",
      },
    });
  });

  it("keeps offline toggles device-local", () => {
    expect(
      createPlanModePreferenceWrite({
        value: false,
        connectedEnvironmentIds: [],
        now: "2026-08-14T12:00:00.000Z",
      }),
    ).toEqual({
      localPatch: {
        planModeEnabled: false,
        syncedClientPreferencesUpdatedAtByField: {
          planModeEnabled: "2026-08-14T12:00:00.000Z",
        },
      },
      environmentPatches: [],
    });
  });

  it("stamps only fields included in a partial local write", () => {
    expect(
      createSyncedClientPreferencesWrite({
        patch: { planModeEnabled: true },
        connectedEnvironmentIds: [environmentId("environment-1")],
        currentUpdatedAtByField: {
          planModeEnabled: "2026-08-14T12:00:00.000Z",
          appearanceMode: "2026-08-14T13:00:00.000Z",
        },
        now: "2026-08-14T12:30:00.000Z",
      }),
    ).toEqual({
      localPatch: {
        values: { planModeEnabled: true },
        updatedAtByField: {
          planModeEnabled: "2026-08-14T12:30:00.000Z",
          appearanceMode: "2026-08-14T13:00:00.000Z",
        },
      },
      environmentPatches: [
        {
          environmentId: environmentId("environment-1"),
          input: {
            patch: { planModeEnabled: true },
            updatedAt: "2026-08-14T12:30:00.000Z",
          },
        },
      ],
    });
  });

  it("reconciles stale environments to the most recent stamped value", () => {
    const reconciliation = reconcilePlanModePreferences({
      localPlanModeEnabled: false,
      localUpdatedAt: "2026-08-14T10:00:00.000Z",
      environments: [
        {
          environmentId: environmentId("environment-1"),
          preferences: {
            planModeEnabled: false,
            updatedAt: "2026-08-14T11:00:00.000Z",
          },
        },
        {
          environmentId: environmentId("environment-2"),
          preferences: {
            planModeEnabled: true,
            updatedAt: "2026-08-14T12:00:00.000Z",
          },
        },
      ],
      now: "2026-08-14T12:01:00.000Z",
    });

    expect(reconciliation.localPatch).toMatchObject({ planModeEnabled: true });
    expect(reconciliation.environmentPatches).toHaveLength(1);
    expect(reconciliation.environmentPatches[0]?.environmentId).toBe(
      environmentId("environment-1"),
    );
    expect(reconciliation.environmentPatches[0]?.input.patch.planModeEnabled).toBe(true);
  });

  it("reconciles the deterministic equal-stamp winner after topology changes", async () => {
    const updatedAt = "2026-08-14T12:00:00.000Z";
    const lowerEnvironmentId = environmentId("environment-1");
    const higherEnvironmentId = environmentId("environment-2");
    const initial = reconcilePlanModePreferences({
      localPlanModeEnabled: false,
      localUpdatedAt: updatedAt,
      environments: [{ environmentId: lowerEnvironmentId, preferences: undefined }],
      now: updatedAt,
    });
    const controller = createSyncedClientPreferenceReconciliationController("planModeEnabled");
    const patch = vi.fn(async (target: (typeof initial.environmentPatches)[number]) =>
      AsyncResult.success({
        planModeEnabled: target.input.patch.planModeEnabled,
        updatedAt: target.input.updatedAt,
      }),
    );
    controller.setActiveEnvironmentIds([lowerEnvironmentId]);
    controller.reconcile({ target: initial.environmentPatches[0]!, patch, persist: vi.fn() });
    await flushReconciliation();

    const environments = [
      {
        environmentId: lowerEnvironmentId,
        preferences: { planModeEnabled: false, updatedAt },
      },
      {
        environmentId: higherEnvironmentId,
        preferences: { planModeEnabled: true, updatedAt },
      },
    ];
    const ascending = reconcilePlanModePreferences({
      localPlanModeEnabled: false,
      localUpdatedAt: updatedAt,
      environments,
      now: updatedAt,
    });
    const descending = reconcilePlanModePreferences({
      localPlanModeEnabled: false,
      localUpdatedAt: updatedAt,
      environments: [environments[1]!, environments[0]!],
      now: updatedAt,
    });
    controller.reconcile({ target: ascending.environmentPatches[0]!, patch, persist: vi.fn() });
    await flushReconciliation();

    const expected = {
      localPatch: {
        planModeEnabled: true,
        syncedClientPreferencesUpdatedAtByField: { planModeEnabled: updatedAt },
      },
      environmentPatches: [
        {
          environmentId: lowerEnvironmentId,
          input: { patch: { planModeEnabled: true }, updatedAt },
        },
      ],
    };
    expect({
      ascending,
      descending,
      patchedValues: patch.mock.calls.map(([target]) => target),
    }).toEqual({
      ascending: expected,
      descending: expected,
      patchedValues: [
        {
          environmentId: lowerEnvironmentId,
          input: { patch: { planModeEnabled: false }, updatedAt },
        },
        {
          environmentId: lowerEnvironmentId,
          input: { patch: { planModeEnabled: true }, updatedAt },
        },
      ],
    });
  });

  it("reconciles when ES2023 change-by-copy array methods are unavailable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
    Reflect.defineProperty(Array.prototype, "toSorted", {
      configurable: true,
      value: undefined,
    });

    try {
      const reconciliation = reconcilePlanModePreferences({
        localPlanModeEnabled: false,
        localUpdatedAt: "2026-08-14T10:00:00.000Z",
        environments: [
          {
            environmentId: environmentId("older"),
            preferences: {
              planModeEnabled: false,
              updatedAt: "2026-08-14T11:00:00.000Z",
            },
          },
          {
            environmentId: environmentId("newer"),
            preferences: {
              planModeEnabled: true,
              updatedAt: "2026-08-14T12:00:00.000Z",
            },
          },
        ],
        now: "2026-08-14T12:01:00.000Z",
      });

      expect(reconciliation.localPatch?.planModeEnabled).toBe(true);
    } finally {
      if (descriptor === undefined) {
        Reflect.deleteProperty(Array.prototype, "toSorted");
      } else {
        Reflect.defineProperty(Array.prototype, "toSorted", descriptor);
      }
    }
  });

  it("reuses the winning stamp across pre-ack reconciliation passes", () => {
    const environments = [
      {
        environmentId: environmentId("environment-1"),
        preferences: {
          planModeEnabled: false,
          updatedAt: "2026-08-14T11:00:00.000Z",
        },
      },
      {
        environmentId: environmentId("environment-2"),
        preferences: {
          planModeEnabled: true,
          updatedAt: "2026-08-14T12:00:00.000Z",
        },
      },
    ];
    const first = reconcilePlanModePreferences({
      localPlanModeEnabled: false,
      localUpdatedAt: "2026-08-14T10:00:00.000Z",
      environments,
      now: "2026-08-14T12:01:00.000Z",
    });
    const second = reconcilePlanModePreferences({
      localPlanModeEnabled: first.localPatch?.planModeEnabled,
      localUpdatedAt: first.localPatch?.syncedClientPreferencesUpdatedAtByField?.planModeEnabled,
      environments,
      now: "2026-08-14T12:01:01.000Z",
    });

    expect(first.environmentPatches[0]?.input.updatedAt).toBe("2026-08-14T12:00:00.000Z");
    expect(second.environmentPatches[0]?.input.updatedAt).toBe(
      first.environmentPatches[0]?.input.updatedAt,
    );
  });

  it("does not advance plan mode past a newer non-plan preference stamp", () => {
    const environments = [
      {
        environmentId: environmentId("appearance-only"),
        preferences: {
          appearanceMode: "dark" as const,
          updatedAt: "2026-08-14T13:00:00.000Z",
        },
      },
      {
        environmentId: environmentId("plan-source"),
        preferences: {
          planModeEnabled: true,
          updatedAt: "2026-08-14T12:00:00.000Z",
        },
      },
    ];
    const first = reconcilePlanModePreferences({
      localPlanModeEnabled: false,
      localUpdatedAt: "2026-08-14T11:00:00.000Z",
      environments,
      now: "2026-08-14T12:59:00.000Z",
    });
    const second = reconcilePlanModePreferences({
      localPlanModeEnabled: first.localPatch?.planModeEnabled,
      localUpdatedAt: first.localPatch?.syncedClientPreferencesUpdatedAtByField?.planModeEnabled,
      environments,
      now: "2026-08-14T13:01:00.000Z",
    });

    expect(first.environmentPatches).toHaveLength(1);
    expect(first.environmentPatches[0]?.input.updatedAt).toBe("2026-08-14T12:00:00.000Z");
    expect(second.environmentPatches[0]?.input.updatedAt).toBe(
      first.environmentPatches[0]?.input.updatedAt,
    );
  });

  it("adopts a newer appearance while pushing only an offline plan write", () => {
    const reconciliation = reconcileSyncedClientPreferences({
      local: {
        values: { planModeEnabled: true, appearanceMode: "light" },
        updatedAtByField: {
          planModeEnabled: "2026-08-14T12:00:00.001Z",
          appearanceMode: "2026-08-14T11:00:00.000Z",
        },
      },
      environments: [
        {
          environmentId: environmentId("environment-1"),
          preferences: {
            planModeEnabled: false,
            appearanceMode: "dark",
            updatedAtByField: {
              planModeEnabled: "2026-08-14T12:00:00.000Z",
              appearanceMode: "2026-08-14T13:00:00.000Z",
            },
            updatedAt: "2026-08-14T13:00:00.000Z",
          },
        },
      ],
      now: "2026-08-14T14:00:00.000Z",
    });

    expect(reconciliation.localPatch).toEqual({
      values: { appearanceMode: "dark" },
      updatedAtByField: {
        planModeEnabled: "2026-08-14T12:00:00.001Z",
        appearanceMode: "2026-08-14T13:00:00.000Z",
      },
    });
    expect(reconciliation.environmentPatches).toEqual([
      {
        environmentId: environmentId("environment-1"),
        input: {
          patch: { planModeEnabled: true },
          updatedAt: "2026-08-14T12:00:00.001Z",
        },
      },
    ]);
  });

  it("stabilizes unavailable remote theme ids at the local fallback", () => {
    const environment = {
      environmentId: environmentId("environment-1"),
      preferences: {
        themeId: "remote-custom-theme",
        updatedAtByField: { themeId: "2026-08-14T13:00:00.000Z" },
        updatedAt: "2026-08-14T13:00:00.000Z",
      },
    } as const;
    const normalizeThemeId = () => "t3-code";
    const first = reconcileSyncedClientPreferences({
      local: {
        values: { themeId: "t3-code" },
        updatedAtByField: { themeId: "2026-08-14T12:00:00.000Z" },
      },
      environments: [environment],
      now: "2026-08-14T14:00:00.000Z",
      normalizeThemeId,
    });
    const second = reconcileSyncedClientPreferences({
      local: {
        values: first.localPatch?.values ?? {},
        updatedAtByField: first.localPatch?.updatedAtByField,
      },
      environments: [environment],
      now: "2026-08-14T14:00:00.000Z",
      normalizeThemeId,
    });

    expect(first.localPatch).toEqual({
      values: { themeId: "t3-code" },
      updatedAtByField: { themeId: "2026-08-14T13:00:00.000Z" },
    });
    expect(second.localPatch).toBeNull();
    expect(second.environmentPatches).toEqual([]);
  });

  it("patches only stale environments after a peer converges", () => {
    const reconciliation = reconcilePlanModePreferences({
      localPlanModeEnabled: true,
      localUpdatedAt: "2026-08-14T12:00:00.000Z",
      environments: [
        {
          environmentId: environmentId("current"),
          preferences: {
            planModeEnabled: true,
            updatedAt: "2026-08-14T12:00:00.000Z",
          },
        },
        {
          environmentId: environmentId("stale"),
          preferences: {
            planModeEnabled: false,
            updatedAt: "2026-08-14T11:00:00.000Z",
          },
        },
      ],
      now: "2026-08-14T12:01:00.000Z",
    });

    expect(reconciliation.environmentPatches.map((target) => target.environmentId)).toEqual([
      environmentId("stale"),
    ]);
  });

  it("preserves a newer local stamp when a later environment has an intermediate stamp", () => {
    const localUpdatedAt = "2026-08-14T12:02:00.000Z";
    const first = reconcilePlanModePreferences({
      localPlanModeEnabled: true,
      localUpdatedAt,
      environments: [
        {
          environmentId: environmentId("observed"),
          preferences: {
            planModeEnabled: false,
            updatedAt: "2026-08-14T12:00:00.000Z",
          },
        },
      ],
      now: "2026-08-14T12:03:00.000Z",
    });
    const second = reconcilePlanModePreferences({
      localPlanModeEnabled: first.localPatch?.planModeEnabled ?? true,
      localUpdatedAt:
        first.localPatch?.syncedClientPreferencesUpdatedAtByField?.planModeEnabled ??
        localUpdatedAt,
      environments: [
        {
          environmentId: environmentId("later"),
          preferences: {
            planModeEnabled: false,
            updatedAt: "2026-08-14T12:01:00.000Z",
          },
        },
      ],
      now: "2026-08-14T12:03:00.000Z",
    });

    expect([first, second]).toEqual([
      {
        localPatch: null,
        environmentPatches: [
          {
            environmentId: environmentId("observed"),
            input: {
              patch: { planModeEnabled: true },
              updatedAt: localUpdatedAt,
            },
          },
        ],
      },
      {
        localPatch: null,
        environmentPatches: [
          {
            environmentId: environmentId("later"),
            input: {
              patch: { planModeEnabled: true },
              updatedAt: localUpdatedAt,
            },
          },
        ],
      },
    ]);
  });

  it("bounds a future-skewed local stamp just after the newest observed environment stamp", () => {
    const reconciliation = reconcilePlanModePreferences({
      localPlanModeEnabled: true,
      localUpdatedAt: "2099-01-01T00:00:00.000Z",
      environments: [
        {
          environmentId: environmentId("environment-1"),
          canPatch: true,
          preferences: {
            planModeEnabled: false,
            updatedAt: "2026-08-14T12:00:00.000Z",
          },
        },
      ],
      now: "2026-08-14T12:01:00.000Z",
    });

    expect(reconciliation.localPatch).toEqual({
      planModeEnabled: true,
      syncedClientPreferencesUpdatedAtByField: {
        planModeEnabled: "2026-08-14T12:00:00.001Z",
      },
    });
    expect(reconciliation.environmentPatches).toEqual([
      {
        environmentId: environmentId("environment-1"),
        input: {
          patch: { planModeEnabled: true },
          updatedAt: "2026-08-14T12:00:00.001Z",
        },
      },
    ]);
  });

  it("clears pending reconciliation from an older canonical patch ack", async () => {
    const target = {
      environmentId: environmentId("environment-1"),
      input: {
        patch: { planModeEnabled: true },
        updatedAt: "2099-01-01T00:00:00.000Z",
      },
    } as const;
    const canonical = {
      planModeEnabled: true,
      updatedAt: "2026-08-14T12:00:30.000Z",
    } as const;

    const controller = createSyncedClientPreferenceReconciliationController("planModeEnabled");
    const persist = vi.fn();
    controller.setActiveEnvironmentIds([target.environmentId]);
    controller.reconcile({
      target,
      patch: async () => AsyncResult.success(canonical),
      persist,
    });
    await flushReconciliation();

    const next = reconcilePlanModePreferences({
      localPlanModeEnabled: canonical.planModeEnabled,
      localUpdatedAt: canonical.updatedAt,
      environments: [
        {
          environmentId: target.environmentId,
          canPatch: true,
          preferences: canonical,
        },
      ],
      now: "2099-01-01T00:00:01.000Z",
    });

    expect(persist).toHaveBeenCalledWith({
      planModeEnabled: true,
      syncedClientPreferencesUpdatedAtByField: { planModeEnabled: canonical.updatedAt },
    });
    expect(next.environmentPatches).toEqual([]);
  });

  it("does not seed a connected environment without patch scope", () => {
    const reconciliation = reconcilePlanModePreferences({
      localPlanModeEnabled: true,
      localUpdatedAt: undefined,
      environments: [
        {
          environmentId: environmentId("read-only"),
          canPatch: false,
          preferences: undefined,
        },
      ],
      now: "2026-08-14T12:00:00.000Z",
    });

    expect(reconciliation.environmentPatches).toEqual([]);
  });

  it("keeps a newer local choice when the environment is read-only", () => {
    expect(
      reconcilePlanModePreferences({
        localPlanModeEnabled: false,
        localUpdatedAt: "2026-08-14T12:01:00.000Z",
        environments: [
          {
            environmentId: environmentId("read-only"),
            canPatch: false,
            preferences: {
              planModeEnabled: true,
              updatedAt: "2026-08-14T12:00:00.000Z",
            },
          },
        ],
        now: "2026-08-14T12:01:00.000Z",
      }),
    ).toEqual({ localPatch: null, environmentPatches: [] });
  });

  it("retries failed reconciliation and succeeds within the cap", async () => {
    const environment = environmentId("environment-1");
    const target = {
      environmentId: environment,
      input: {
        patch: { planModeEnabled: true },
        updatedAt: "2026-08-14T12:00:00.000Z",
      },
    } as const;
    const { schedule, scheduled } = makeRetryScheduler();
    const controller = createSyncedClientPreferenceReconciliationController(
      "planModeEnabled",
      schedule,
    );
    const patch = vi
      .fn()
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail("offline")))
      .mockResolvedValueOnce(
        AsyncResult.success({
          planModeEnabled: true,
          updatedAt: target.input.updatedAt,
        }),
      );
    const persist = vi.fn();

    controller.setActiveEnvironmentIds([environment]);
    controller.reconcile({ target, patch, persist });
    await flushReconciliation();

    expect(patch).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(1_000);

    scheduled[0]?.run();
    await flushReconciliation();

    expect(patch).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledWith({
      planModeEnabled: true,
      syncedClientPreferencesUpdatedAtByField: {
        planModeEnabled: target.input.updatedAt,
      },
    });
  });

  it("stops retrying automatically after exhausting reconciliation retries", async () => {
    const environment = environmentId("environment-1");
    const target = {
      environmentId: environment,
      input: {
        patch: { planModeEnabled: true },
        updatedAt: "2026-08-14T12:00:00.000Z",
      },
    } as const;
    const { schedule, scheduled } = makeRetryScheduler();
    const controller = createSyncedClientPreferenceReconciliationController(
      "planModeEnabled",
      schedule,
    );
    const patch = vi.fn().mockResolvedValue(AsyncResult.failure(Cause.fail("offline")));

    controller.setActiveEnvironmentIds([environment]);
    controller.reconcile({ target, patch, persist: vi.fn() });
    await flushReconciliation();
    scheduled[0]?.run();
    await flushReconciliation();
    scheduled[1]?.run();
    await flushReconciliation();

    expect(patch).toHaveBeenCalledTimes(3);
    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([1_000, 2_000]);
  });

  it("retries an exhausted reconciliation on a later trigger", async () => {
    const environment = environmentId("environment-1");
    const target = {
      environmentId: environment,
      input: {
        patch: { planModeEnabled: true },
        updatedAt: "2026-08-14T12:00:00.000Z",
      },
    } as const;
    const { schedule, scheduled } = makeRetryScheduler();
    const controller = createSyncedClientPreferenceReconciliationController(
      "planModeEnabled",
      schedule,
    );
    const patch = vi
      .fn()
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail("offline")))
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail("offline")))
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail("offline")))
      .mockResolvedValueOnce(
        AsyncResult.success({
          planModeEnabled: true,
          updatedAt: target.input.updatedAt,
        }),
      );
    const persist = vi.fn();

    controller.setActiveEnvironmentIds([environment]);
    controller.reconcile({ target, patch, persist });
    await flushReconciliation();
    scheduled[0]?.run();
    await flushReconciliation();
    scheduled[1]?.run();
    await flushReconciliation();

    expect(patch).toHaveBeenCalledTimes(3);

    controller.reconcile({ target, patch, persist });
    await flushReconciliation();

    expect(patch).toHaveBeenCalledTimes(4);
    expect(persist).toHaveBeenCalledWith({
      planModeEnabled: true,
      syncedClientPreferencesUpdatedAtByField: {
        planModeEnabled: target.input.updatedAt,
      },
    });
  });

  it.each(["disconnect", "unmount"] as const)(
    "cancels a scheduled reconciliation retry on %s",
    async (lifecycleExit) => {
      const environment = environmentId("environment-1");
      const target = {
        environmentId: environment,
        input: {
          patch: { planModeEnabled: true },
          updatedAt: "2026-08-14T12:00:00.000Z",
        },
      } as const;
      const { schedule, scheduled } = makeRetryScheduler();
      const controller = createSyncedClientPreferenceReconciliationController(
        "planModeEnabled",
        schedule,
      );
      const patch = vi.fn().mockResolvedValue(AsyncResult.failure(Cause.fail("offline")));

      controller.setActiveEnvironmentIds([environment]);
      controller.reconcile({ target, patch, persist: vi.fn() });
      await flushReconciliation();
      if (lifecycleExit === "disconnect") {
        controller.setActiveEnvironmentIds([]);
      } else {
        controller.reset();
      }

      expect(scheduled[0]?.cancelled()).toBe(true);
      scheduled[0]?.run();
      await flushReconciliation();
      expect(patch).toHaveBeenCalledTimes(1);
    },
  );
});
