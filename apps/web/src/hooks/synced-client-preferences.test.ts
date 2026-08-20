import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createSyncedClientPreferenceHydrationController,
  createSyncedClientPreferenceWrite,
  resolveSyncedPlanModeCoordinatorEnvironmentIds,
  resolveSyncedClientPreferenceHydrationAction,
} from "./synced-client-preferences";

const UPDATED_AT = "2026-08-14T12:00:00.000Z";

describe("synced client preferences", () => {
  it("hydrates the primary before exposing secondary environments", () => {
    const primaryEnvironmentId = EnvironmentId.make("primary");
    const secondaryEnvironmentId = EnvironmentId.make("secondary");
    const environmentIds = [primaryEnvironmentId, secondaryEnvironmentId];

    expect(
      resolveSyncedPlanModeCoordinatorEnvironmentIds({
        environmentIds,
        primaryEnvironmentId,
        hydratedPrimaryEnvironmentId: null,
        primaryUnavailable: false,
      }),
    ).toEqual([primaryEnvironmentId]);
    expect(
      resolveSyncedPlanModeCoordinatorEnvironmentIds({
        environmentIds,
        primaryEnvironmentId,
        hydratedPrimaryEnvironmentId: primaryEnvironmentId,
        primaryUnavailable: false,
      }),
    ).toEqual(environmentIds);

    const events: string[] = [];
    createSyncedClientPreferenceHydrationController("planModeEnabled").synchronize({
      environmentId: primaryEnvironmentId,
      primaryEnvironmentId,
      clientHydrated: true,
      clientValue: false,
      live: true,
      serverPreferences: {
        planModeEnabled: true,
        updatedAtByField: { planModeEnabled: UPDATED_AT },
        updatedAt: UPDATED_AT,
      },
      canPatch: true,
      now: "2026-08-14T12:01:00.000Z",
      patch: vi.fn(),
      persist: (value, updatedAt) => {
        events.push(`persist:${value}:${updatedAt}`);
        return true;
      },
      onHydrated: () => events.push("hydrated"),
    });

    expect(events).toEqual([`persist:true:${UPDATED_AT}`, "hydrated"]);
  });

  it("ignores malformed durable field clocks", () => {
    const serverPreferences = {
      planModeEnabled: false,
      updatedAtByField: { planModeEnabled: UPDATED_AT },
      updatedAt: UPDATED_AT,
    } as const;
    expect(
      createSyncedClientPreferenceWrite({
        field: "planModeEnabled",
        value: true,
        serverPreferences,
        pendingUpdatedAt: "not-a-timestamp",
        now: "2026-08-14T12:01:00.000Z",
      }).request.updatedAt,
    ).toBe("2026-08-14T12:01:00.000Z");

    const environmentId = EnvironmentId.make("primary");
    const persist = vi.fn(() => true);
    createSyncedClientPreferenceHydrationController("planModeEnabled").synchronize({
      environmentId,
      primaryEnvironmentId: environmentId,
      clientHydrated: true,
      clientValue: true,
      clientUpdatedAt: "not-a-timestamp",
      live: true,
      serverPreferences,
      canPatch: true,
      now: "2026-08-14T12:01:00.000Z",
      patch: vi.fn(),
      persist,
    });

    expect(persist).toHaveBeenCalledWith(false, UPDATED_AT);
  });

  it("waits through transient primary shell states", () => {
    const primaryEnvironmentId = EnvironmentId.make("primary");
    const onHydrated = vi.fn();

    createSyncedClientPreferenceHydrationController("planModeEnabled").synchronize({
      environmentId: primaryEnvironmentId,
      primaryEnvironmentId,
      clientHydrated: true,
      clientValue: false,
      live: false,
      serverPreferences: undefined,
      canPatch: false,
      now: "2026-08-14T12:01:00.000Z",
      patch: vi.fn(),
      persist: vi.fn(() => true),
      onHydrated,
    });

    expect(onHydrated).not.toHaveBeenCalled();
  });

  it("releases secondary hydration when the primary connection is unavailable", () => {
    const primaryEnvironmentId = EnvironmentId.make("primary");
    expect(
      resolveSyncedPlanModeCoordinatorEnvironmentIds({
        environmentIds: [primaryEnvironmentId, EnvironmentId.make("secondary")],
        primaryEnvironmentId,
        hydratedPrimaryEnvironmentId: null,
        primaryUnavailable: true,
      }),
    ).toHaveLength(2);
  });

  it("releases all environments when no unavailable primary is designated", () => {
    const environmentIds = [EnvironmentId.make("first"), EnvironmentId.make("second")];
    expect(
      resolveSyncedPlanModeCoordinatorEnvironmentIds({
        environmentIds,
        primaryEnvironmentId: null,
        hydratedPrimaryEnvironmentId: null,
        primaryUnavailable: true,
      }),
    ).toEqual(environmentIds);
  });

  it("retries local adoption instead of completing hydration after persistence fails", () => {
    const environmentId = EnvironmentId.make("primary");
    const scheduledRetries: Array<{ readonly delayMs: number; readonly run: () => void }> = [];
    const controller = createSyncedClientPreferenceHydrationController(
      "lightThemeId",
      (retry, delayMs) => {
        scheduledRetries.push({ delayMs, run: retry });
        return vi.fn();
      },
    );
    const persist = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const onHydrated = vi.fn();
    const input = {
      environmentId,
      primaryEnvironmentId: environmentId,
      clientHydrated: true,
      clientValue: "t3-code",
      live: true,
      serverPreferences: {
        lightThemeId: "dracula",
        updatedAtByField: { lightThemeId: UPDATED_AT },
        updatedAt: UPDATED_AT,
      },
      canPatch: true,
      now: "2026-08-14T12:01:00.000Z",
      patch: vi.fn(),
      persist,
      onHydrated,
    } as const;

    controller.synchronize(input);
    expect(persist).toHaveBeenCalledOnce();
    expect(onHydrated).not.toHaveBeenCalled();
    expect(scheduledRetries).toHaveLength(1);

    // React may re-enter synchronization while the first timer owns the retry
    // slot. Those renders must not consume future scheduled attempts.
    controller.synchronize(input);
    controller.synchronize(input);
    expect(persist).toHaveBeenCalledTimes(3);
    expect(scheduledRetries.map(({ delayMs }) => delayMs)).toEqual([1_000]);

    scheduledRetries[0]?.run();
    expect(persist).toHaveBeenCalledTimes(4);
    expect(scheduledRetries.map(({ delayMs }) => delayMs)).toEqual([1_000, 2_000]);
    expect(onHydrated).not.toHaveBeenCalled();

    scheduledRetries[1]?.run();
    expect(persist).toHaveBeenCalledTimes(5);
    expect(onHydrated).toHaveBeenCalledOnce();
  });

  it("creates independent theme-half writes with collision-safe command ids", () => {
    const light = createSyncedClientPreferenceWrite({
      field: "lightThemeId",
      value: "dracula",
      serverPreferences: undefined,
      now: UPDATED_AT,
    });
    const dark = createSyncedClientPreferenceWrite({
      field: "darkThemeId",
      value: "dracula",
      serverPreferences: undefined,
      now: UPDATED_AT,
    });

    expect(light.request.patch).toEqual({ lightThemeId: "dracula" });
    expect(dark.request.patch).toEqual({ darkThemeId: "dracula" });
    expect(light.request.commandId).not.toBe(dark.request.commandId);
  });

  it("adopts a newer server value using its field clock", () => {
    expect(
      resolveSyncedClientPreferenceHydrationAction({
        field: "appearanceMode",
        clientHydrated: true,
        clientValue: "system",
        serverPreferences: {
          appearanceMode: "dark",
          updatedAtByField: { appearanceMode: UPDATED_AT },
          updatedAt: UPDATED_AT,
        },
        seedPending: false,
        now: "2026-08-14T12:01:00.000Z",
      }),
    ).toEqual({ type: "adopt", value: "dark", updatedAt: UPDATED_AT });
  });

  it("keeps an offline write pending and sends it after authorization arrives", async () => {
    const controller = createSyncedClientPreferenceHydrationController("lightThemeId");
    const environmentId = EnvironmentId.make("environment-a");
    const patch = vi.fn(async (target) =>
      AsyncResult.success({
        lightThemeId: target.input.patch.lightThemeId,
        updatedAtByField: { lightThemeId: target.input.updatedAt },
        updatedAt: target.input.updatedAt,
      }),
    );
    const persist = vi.fn(() => true);

    controller.write({
      environmentId,
      value: "dracula",
      serverPreferences: undefined,
      canPatch: false,
      now: UPDATED_AT,
      patch,
      persist,
    });
    expect(patch).not.toHaveBeenCalled();

    controller.synchronize({
      environmentId,
      primaryEnvironmentId: environmentId,
      clientHydrated: true,
      clientValue: "dracula",
      clientUpdatedAt: UPDATED_AT,
      live: true,
      serverPreferences: undefined,
      canPatch: true,
      now: UPDATED_AT,
      patch,
      persist,
    });
    await Promise.resolve();

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]?.[0].input.patch).toEqual({ lightThemeId: "dracula" });
  });
});
