import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createSyncedClientPreferenceHydrationController,
  createSyncedClientPreferenceWrite,
  resolveSyncedClientPreferenceHydrationAction,
} from "./synced-client-preferences";

const UPDATED_AT = "2026-08-14T12:00:00.000Z";

describe("synced client preferences", () => {
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
    const persist = vi.fn();
    const persistUpdatedAt = vi.fn();

    controller.write({
      environmentId,
      value: "dracula",
      serverPreferences: undefined,
      canPatch: false,
      now: UPDATED_AT,
      patch,
      persist,
      persistUpdatedAt,
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
      persistUpdatedAt,
    });
    await Promise.resolve();

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]?.[0].input.patch).toEqual({ lightThemeId: "dracula" });
  });
});
