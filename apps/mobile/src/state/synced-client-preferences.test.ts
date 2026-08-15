import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createPlanModePreferenceReconciliationController,
  createPlanModePreferenceWrite,
  createPlanModePreferenceWriteController,
  fanOutPlanModePreferencePatches,
  nextMobileSyncedPreferencesUpdatedAt,
  reconcilePlanModePreferences,
  settlePendingPlanModePreferencePatch,
} from "./synced-client-preferences-model";

const environmentId = (value: string) => EnvironmentId.make(value);

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
        syncedClientPreferencesUpdatedAt: "2026-08-14T12:00:00.000Z",
      },
      environmentPatches: [],
    });
  });

  it("fans a mobile toggle out to every connected environment", () => {
    const write = createPlanModePreferenceWrite({
      value: true,
      connectedEnvironmentIds: [environmentId("environment-1"), environmentId("environment-2")],
      currentUpdatedAts: ["2026-08-14T12:00:00.000Z"],
      authoritativeUpdatedAts: ["2026-08-14T12:02:00.000Z"],
      now: "2026-08-14T12:01:00.000Z",
    });

    expect(write.localPatch).toEqual({
      planModeEnabled: true,
      syncedClientPreferencesUpdatedAt: "2026-08-14T12:02:00.001Z",
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
    const controller = createPlanModePreferenceWriteController();
    const environment = environmentId("environment-1");
    const first = controller.create({
      value: true,
      connectedEnvironmentIds: [environment],
      currentUpdatedAts: [],
      now: "2026-08-14T12:00:00.000Z",
    });
    const second = controller.create({
      value: false,
      connectedEnvironmentIds: [environment],
      currentUpdatedAts: [],
      now: "2026-08-14T12:00:00.000Z",
    });

    expect(second.localPatch.syncedClientPreferencesUpdatedAt).toBe("2026-08-14T12:00:00.001Z");
    expect(
      controller.settle({
        target: second.environmentPatches[0]!,
        result: AsyncResult.success({
          planModeEnabled: false,
          updatedAt: second.environmentPatches[0]!.input.updatedAt,
        }),
      }),
    ).toEqual(second.localPatch);
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

  it("keeps offline toggles device-local", () => {
    expect(
      createPlanModePreferenceWrite({
        value: false,
        connectedEnvironmentIds: [],
        currentUpdatedAts: [],
        now: "2026-08-14T12:00:00.000Z",
      }),
    ).toEqual({
      localPatch: {
        planModeEnabled: false,
        syncedClientPreferencesUpdatedAt: "2026-08-14T12:00:00.000Z",
      },
      environmentPatches: [],
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

  it("reconciles when ES2023 change-by-copy array methods are unavailable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
    // oxlint-disable-next-line no-extend-native -- Simulate Hermes, which omits this method.
    Object.defineProperty(Array.prototype, "toSorted", {
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
        // oxlint-disable-next-line no-extend-native -- Restore the pre-test implementation.
        Object.defineProperty(Array.prototype, "toSorted", descriptor);
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
      localUpdatedAt: first.localPatch?.syncedClientPreferencesUpdatedAt,
      environments,
      now: "2026-08-14T12:01:01.000Z",
    });

    expect(first.environmentPatches[0]?.input.updatedAt).toBe("2026-08-14T12:00:00.000Z");
    expect(second.environmentPatches[0]?.input.updatedAt).toBe(
      first.environmentPatches[0]?.input.updatedAt,
    );
  });

  it("advances once past a newer non-plan preference stamp", () => {
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
      localUpdatedAt: first.localPatch?.syncedClientPreferencesUpdatedAt,
      environments,
      now: "2026-08-14T13:01:00.000Z",
    });

    expect(first.environmentPatches).toHaveLength(2);
    expect(first.environmentPatches[0]?.input.updatedAt).toBe("2026-08-14T13:00:00.001Z");
    expect(second.environmentPatches[0]?.input.updatedAt).toBe(
      first.environmentPatches[0]?.input.updatedAt,
    );
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

  it("bounds a fast device clock just after the newest observed environment stamp", () => {
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
      now: "2099-01-01T00:00:01.000Z",
    });

    expect(reconciliation.localPatch).toEqual({
      planModeEnabled: true,
      syncedClientPreferencesUpdatedAt: "2026-08-14T12:00:00.001Z",
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

  it("clears pending reconciliation from an older canonical patch ack", () => {
    const target = {
      environmentId: environmentId("environment-1"),
      input: {
        patch: { planModeEnabled: true },
        updatedAt: "2099-01-01T00:00:00.000Z",
      },
    } as const;
    const pendingByEnvironment = new Map([[target.environmentId, target.input.updatedAt]]);
    const canonical = {
      planModeEnabled: true,
      updatedAt: "2026-08-14T12:00:30.000Z",
    } as const;

    const localPatch = settlePendingPlanModePreferencePatch({
      pendingByEnvironment,
      target,
      result: AsyncResult.success(canonical),
    });
    const next = reconcilePlanModePreferences({
      localPlanModeEnabled: localPatch?.planModeEnabled,
      localUpdatedAt: localPatch?.syncedClientPreferencesUpdatedAt,
      environments: [
        {
          environmentId: target.environmentId,
          canPatch: true,
          preferences: canonical,
        },
      ],
      now: "2099-01-01T00:00:01.000Z",
    });

    expect(pendingByEnvironment.size).toBe(0);
    expect(localPatch).toEqual({
      planModeEnabled: true,
      syncedClientPreferencesUpdatedAt: canonical.updatedAt,
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

  it("continues fan-out when one environment write fails", async () => {
    const attempted: string[] = [];
    const targets = createPlanModePreferenceWrite({
      value: true,
      connectedEnvironmentIds: [environmentId("failing"), environmentId("healthy")],
      currentUpdatedAts: [],
      now: "2026-08-14T12:00:00.000Z",
    }).environmentPatches;

    await expect(
      fanOutPlanModePreferencePatches(targets, async (target) => {
        attempted.push(target.environmentId);
        if (target.environmentId === environmentId("failing")) throw new Error("offline");
      }),
    ).resolves.toBeUndefined();
    expect(attempted).toEqual([environmentId("failing"), environmentId("healthy")]);
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
    const controller = createPlanModePreferenceReconciliationController(schedule);
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
      syncedClientPreferencesUpdatedAt: target.input.updatedAt,
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
    const controller = createPlanModePreferenceReconciliationController(schedule);
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
    const controller = createPlanModePreferenceReconciliationController(schedule);
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
      syncedClientPreferencesUpdatedAt: target.input.updatedAt,
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
      const controller = createPlanModePreferenceReconciliationController(schedule);
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
