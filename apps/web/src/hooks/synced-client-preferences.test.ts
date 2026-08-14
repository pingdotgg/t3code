import { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createSyncedClientPreferenceHydrationController,
  createSyncedClientPreferenceWrite,
  createSyncedClientPreferencesSliceAtom,
  createSyncedPlanModeHydrationController,
  createSyncedPlanModeWrite,
  resolveSyncedClientPreferenceHydrationAction,
  resolveSyncedPlanModeHydrationAction,
  type SyncedClientPreferenceHydrationInput,
  type SyncedPlanModeHydrationInput,
} from "./synced-client-preferences";

describe("synced client preferences", () => {
  it("adopts an environment value over the local cache", () => {
    expect(
      resolveSyncedPlanModeHydrationAction({
        clientHydrated: true,
        clientValue: false,
        serverPreferences: {
          planModeEnabled: true,
          updatedAt: "2026-08-14T12:00:00.000Z",
        },
        seedPending: false,
        now: "2026-08-14T12:01:00.000Z",
      }),
    ).toEqual({
      type: "adopt",
      value: true,
      updatedAt: "2026-08-14T12:00:00.000Z",
    });
  });

  it("seeds a missing environment value once from the local cache", () => {
    expect(
      resolveSyncedPlanModeHydrationAction({
        clientHydrated: true,
        clientValue: true,
        serverPreferences: {
          appearanceMode: "dark",
          updatedAt: "2026-08-14T12:00:00.000Z",
        },
        seedPending: false,
        now: "2026-08-14T11:00:00.000Z",
      }),
    ).toEqual({
      type: "seed",
      value: true,
      updatedAt: "2026-08-14T11:00:00.000Z",
    });
    expect(
      resolveSyncedPlanModeHydrationAction({
        clientHydrated: true,
        clientValue: true,
        serverPreferences: undefined,
        seedPending: true,
        now: "2026-08-14T12:01:00.000Z",
      }),
    ).toEqual({ type: "none" });
  });

  it("writes one stamped value to the local and environment stores", () => {
    expect(
      createSyncedPlanModeWrite({
        value: false,
        serverPreferences: {
          planModeEnabled: true,
          updatedAt: "2026-08-14T12:00:00.000Z",
        },
        now: "2026-08-14T12:01:00.000Z",
      }),
    ).toEqual({
      clientPatch: { planModeEnabled: false },
      request: {
        patch: { planModeEnabled: false },
        updatedAt: "2026-08-14T12:01:00.000Z",
      },
    });
  });

  it("advances writes from the plan clock instead of a newer appearance clock", () => {
    expect(
      createSyncedPlanModeWrite({
        value: false,
        serverPreferences: {
          planModeEnabled: true,
          appearanceMode: "dark",
          updatedAtByField: {
            planModeEnabled: "2026-08-14T12:00:00.000Z",
            appearanceMode: "2026-08-14T13:00:00.000Z",
          },
          updatedAt: "2026-08-14T13:00:00.000Z",
        },
        now: "2026-08-14T12:30:00.000Z",
      }),
    ).toMatchObject({
      request: { updatedAt: "2026-08-14T12:30:00.000Z" },
    });
  });

  it("advances theme writes from the theme clock instead of a newer appearance clock", () => {
    expect(
      createSyncedClientPreferenceWrite({
        field: "themeId",
        value: "ocean",
        serverPreferences: {
          appearanceMode: "dark",
          themeId: "iris",
          updatedAtByField: {
            appearanceMode: "2026-08-14T13:00:00.000Z",
            themeId: "2026-08-14T12:00:00.000Z",
          },
          updatedAt: "2026-08-14T13:00:00.000Z",
        },
        now: "2026-08-14T12:30:00.000Z",
      }),
    ).toEqual({
      request: {
        patch: { themeId: "ocean" },
        updatedAt: "2026-08-14T12:30:00.000Z",
      },
    });
  });

  it("adopts appearance with its field stamp, independent of newer theme state", () => {
    expect(
      resolveSyncedClientPreferenceHydrationAction({
        field: "appearanceMode",
        clientHydrated: true,
        clientValue: "light",
        serverPreferences: {
          appearanceMode: "dark",
          themeId: "ocean",
          updatedAtByField: {
            appearanceMode: "2026-08-14T12:00:00.000Z",
            themeId: "2026-08-14T13:00:00.000Z",
          },
          updatedAt: "2026-08-14T13:00:00.000Z",
        },
        seedPending: false,
        now: "2026-08-14T13:01:00.000Z",
      }),
    ).toEqual({
      type: "adopt",
      value: "dark",
      updatedAt: "2026-08-14T12:00:00.000Z",
    });
  });

  it("does not re-adopt stale server state while a local write is pending", () => {
    expect(
      resolveSyncedPlanModeHydrationAction({
        clientHydrated: true,
        clientValue: false,
        serverPreferences: {
          planModeEnabled: true,
          updatedAt: "2026-08-14T12:00:00.000Z",
        },
        seedPending: false,
        writePending: {
          value: false,
          updatedAt: "2026-08-14T12:01:00.000Z",
        },
        now: "2026-08-14T12:01:00.000Z",
      }),
    ).toEqual({ type: "none" });
  });

  it("keeps divergent values stable across primary and secondary synchronization", async () => {
    const primaryEnvironmentId = EnvironmentId.make("primary");
    const secondaryEnvironmentId = EnvironmentId.make("secondary");
    const controller = createSyncedPlanModeHydrationController();
    const persisted: boolean[] = [];
    let localValue = false;
    const persist = (value: boolean) => {
      if (localValue === value) return;
      localValue = value;
      persisted.push(value);
    };
    const patch = vi.fn(async () =>
      AsyncResult.success({
        planModeEnabled: true,
        updatedAt: "2026-08-14T12:00:00.000Z",
      }),
    );
    const primaryOwner = Symbol();
    const secondaryOwner = Symbol();
    let deactivatePrimary: (() => void) | undefined;
    for (let render = 0; render < 10; render += 1) {
      deactivatePrimary?.();
      deactivatePrimary = controller.synchronize(
        {
          environmentId: primaryEnvironmentId,
          primaryEnvironmentId,
          clientHydrated: true,
          clientValue: localValue,
          live: true,
          serverPreferences: {
            planModeEnabled: true,
            updatedAt: "2026-08-14T12:00:00.000Z",
          },
          canPatch: true,
          now: "2026-08-14T12:01:00.000Z",
          patch,
          persist,
        },
        primaryOwner,
      );
      controller.synchronize(
        {
          environmentId: secondaryEnvironmentId,
          primaryEnvironmentId,
          clientHydrated: true,
          clientValue: localValue,
          live: true,
          serverPreferences: {
            planModeEnabled: false,
            updatedAt: "2026-08-14T12:02:00.000Z",
          },
          canPatch: true,
          now: "2026-08-14T12:01:00.000Z",
          patch,
          persist,
        },
        secondaryOwner,
      );
    }
    deactivatePrimary?.();

    expect(localValue).toBe(true);
    expect(persisted).toEqual([true]);
    expect(patch).not.toHaveBeenCalled();
  });

  it("settles a pending write from an older canonical ack without re-patching", async () => {
    const primaryEnvironmentId = EnvironmentId.make("primary");
    const controller = createSyncedPlanModeHydrationController();
    let localValue = false;
    const persist = (value: boolean) => {
      localValue = value;
    };
    const canonical = {
      planModeEnabled: false,
      updatedAt: "2026-08-14T12:00:30.000Z",
    } as const;
    const previous = {
      planModeEnabled: true,
      updatedAt: "2026-08-14T12:00:00.000Z",
    } as const;
    const patch = vi.fn(async () => AsyncResult.success(canonical));

    controller.synchronize({
      environmentId: primaryEnvironmentId,
      primaryEnvironmentId,
      clientHydrated: true,
      clientValue: localValue,
      live: true,
      serverPreferences: previous,
      canPatch: true,
      now: "2026-08-14T12:00:01.000Z",
      patch,
      persist,
    });
    persist(false);
    controller.write({
      environmentId: primaryEnvironmentId,
      value: false,
      serverPreferences: previous,
      canPatch: true,
      now: "2099-01-01T00:00:00.000Z",
      patch,
      persist,
    });
    await Promise.resolve();

    controller.synchronize({
      environmentId: primaryEnvironmentId,
      primaryEnvironmentId,
      clientHydrated: true,
      clientValue: localValue,
      live: true,
      serverPreferences: previous,
      canPatch: true,
      now: "2099-01-01T00:00:01.000Z",
      patch,
      persist,
    });
    for (let render = 0; render < 3; render += 1) {
      controller.synchronize({
        environmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        clientHydrated: true,
        clientValue: localValue,
        live: true,
        serverPreferences: canonical,
        canPatch: true,
        now: "2099-01-01T00:00:01.000Z",
        patch,
        persist,
      });
    }
    await Promise.resolve();

    expect(patch).toHaveBeenCalledTimes(1);
    expect(localValue).toBe(false);
  });

  it("does not seed preferences without orchestration operate scope", () => {
    const primaryEnvironmentId = EnvironmentId.make("read-only");
    const controller = createSyncedPlanModeHydrationController();
    const patch = vi.fn(async () =>
      AsyncResult.success({
        planModeEnabled: false,
        updatedAt: "2026-08-14T12:00:00.000Z",
      }),
    );

    for (let render = 0; render < 3; render += 1) {
      controller.synchronize({
        environmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        clientHydrated: true,
        clientValue: false,
        live: true,
        serverPreferences: undefined,
        canPatch: false,
        now: "2026-08-14T12:00:00.000Z",
        patch,
        persist: vi.fn(),
      });
    }
    controller.write({
      environmentId: primaryEnvironmentId,
      value: true,
      serverPreferences: undefined,
      canPatch: false,
      now: "2026-08-14T12:01:00.000Z",
      patch,
      persist: vi.fn(),
    });

    expect(patch).not.toHaveBeenCalled();
  });

  it("keeps the local fallback when server preferences are read-only", () => {
    const primaryEnvironmentId = EnvironmentId.make("read-only");
    const controller = createSyncedPlanModeHydrationController();
    const persist = vi.fn();
    const patch = vi.fn();

    controller.synchronize({
      environmentId: primaryEnvironmentId,
      primaryEnvironmentId,
      clientHydrated: true,
      clientValue: false,
      live: true,
      serverPreferences: {
        planModeEnabled: true,
        updatedAt: "2026-08-14T12:00:00.000Z",
      },
      canPatch: false,
      now: "2026-08-14T12:01:00.000Z",
      patch,
      persist,
    });

    expect(persist).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("uploads an offline write when patch access becomes available", async () => {
    const primaryEnvironmentId = EnvironmentId.make("primary");
    const controller = createSyncedPlanModeHydrationController();
    const previous = {
      planModeEnabled: false,
      updatedAt: "2026-08-14T12:00:00.000Z",
    } as const;
    const patch = vi.fn(async (target) =>
      AsyncResult.success({
        planModeEnabled: target.input.patch.planModeEnabled,
        updatedAt: target.input.updatedAt,
      }),
    );

    controller.write({
      environmentId: primaryEnvironmentId,
      value: true,
      serverPreferences: previous,
      canPatch: false,
      now: "2026-08-14T12:01:00.000Z",
      patch,
      persist: vi.fn(),
    });
    controller.synchronize({
      environmentId: primaryEnvironmentId,
      primaryEnvironmentId,
      clientHydrated: true,
      clientValue: true,
      live: true,
      serverPreferences: previous,
      canPatch: true,
      now: "2026-08-14T12:02:00.000Z",
      patch,
      persist: vi.fn(),
    });
    await Promise.resolve();

    expect(patch).toHaveBeenCalledWith({
      environmentId: primaryEnvironmentId,
      input: {
        patch: { planModeEnabled: true },
        updatedAt: "2026-08-14T12:01:00.000Z",
      },
    });
  });

  it.each(["write", "seed"] as const)("retries a failed %s patch", async (kind) => {
    const primaryEnvironmentId = EnvironmentId.make("primary");
    const scheduledRetries: Array<() => void> = [];
    const controller = createSyncedPlanModeHydrationController((retry) => {
      scheduledRetries.push(retry);
      return vi.fn();
    });
    const previous = {
      planModeEnabled: false,
      updatedAt: "2026-08-14T12:00:00.000Z",
    } as const;
    const patch = vi
      .fn()
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail("offline")))
      .mockImplementation(async (target) =>
        AsyncResult.success({
          planModeEnabled: target.input.patch.planModeEnabled,
          updatedAt: target.input.updatedAt,
        }),
      );
    const hydrationInput = {
      environmentId: primaryEnvironmentId,
      primaryEnvironmentId,
      clientHydrated: true,
      clientValue: true,
      live: true,
      serverPreferences: kind === "seed" ? undefined : previous,
      canPatch: true,
      now: "2026-08-14T12:01:00.000Z",
      patch,
      persist: vi.fn(),
    } satisfies SyncedPlanModeHydrationInput<string>;

    controller.synchronize(hydrationInput);
    if (kind === "write") {
      controller.write({
        environmentId: primaryEnvironmentId,
        value: true,
        serverPreferences: previous,
        canPatch: true,
        now: "2026-08-14T12:01:00.000Z",
        patch,
        persist: hydrationInput.persist,
      });
    }
    await Promise.resolve();

    expect(scheduledRetries).toHaveLength(1);
    scheduledRetries[0]?.();
    await Promise.resolve();
    expect(patch).toHaveBeenCalledTimes(2);
    controller.reset();
  });

  it("bounds automatic patch retries", async () => {
    const primaryEnvironmentId = EnvironmentId.make("primary");
    const scheduledRetries: Array<{ readonly delayMs: number; readonly run: () => void }> = [];
    const controller = createSyncedClientPreferenceHydrationController(
      "planModeEnabled",
      (retry, delayMs) => {
        scheduledRetries.push({ delayMs, run: retry });
        return vi.fn();
      },
    );
    const previous = {
      planModeEnabled: false,
      updatedAt: "2026-08-14T12:00:00.000Z",
    } as const;
    const patch = vi.fn().mockResolvedValue(AsyncResult.failure(Cause.fail("offline")));
    const hydrationInput = {
      environmentId: primaryEnvironmentId,
      primaryEnvironmentId,
      clientHydrated: true,
      clientValue: false,
      live: true,
      serverPreferences: previous,
      canPatch: true,
      now: "2026-08-14T12:01:00.000Z",
      patch,
      persist: vi.fn(),
    } satisfies SyncedClientPreferenceHydrationInput<"planModeEnabled", string>;

    controller.synchronize(hydrationInput);
    controller.write({
      environmentId: primaryEnvironmentId,
      value: true,
      serverPreferences: previous,
      canPatch: true,
      now: "2026-08-14T12:01:00.000Z",
      patch,
      persist: hydrationInput.persist,
    });
    await Promise.resolve();
    scheduledRetries[0]?.run();
    await Promise.resolve();
    scheduledRetries[1]?.run();
    await Promise.resolve();

    expect(patch).toHaveBeenCalledTimes(3);
    expect(scheduledRetries.map(({ delayMs }) => delayMs)).toEqual([1_000, 2_000]);
    controller.reset();
  });

  it("resets an exhausted retry budget only for a new theme write", async () => {
    const primaryEnvironmentId = EnvironmentId.make("primary");
    const scheduledRetries: Array<() => void> = [];
    const controller = createSyncedClientPreferenceHydrationController("themeId", (retry) => {
      scheduledRetries.push(retry);
      return vi.fn();
    });
    const previous = {
      themeId: "iris",
      updatedAt: "2026-08-14T12:00:00.000Z",
    } as const;
    const patch = vi.fn().mockResolvedValue(AsyncResult.failure(Cause.fail("offline")));
    const hydrationInput = {
      environmentId: primaryEnvironmentId,
      primaryEnvironmentId,
      clientHydrated: true,
      clientValue: "ocean",
      live: true,
      serverPreferences: previous,
      canPatch: true,
      now: "2026-08-14T12:01:00.000Z",
      patch,
      persist: vi.fn(),
    } satisfies SyncedClientPreferenceHydrationInput<"themeId", string>;

    controller.synchronize(hydrationInput);
    controller.write({
      environmentId: primaryEnvironmentId,
      value: "ocean",
      serverPreferences: previous,
      canPatch: true,
      now: hydrationInput.now,
      patch,
      persist: hydrationInput.persist,
    });
    await Promise.resolve();
    scheduledRetries[0]?.();
    await Promise.resolve();
    scheduledRetries[1]?.();
    await Promise.resolve();

    controller.synchronize({
      ...hydrationInput,
      now: "2026-08-14T12:02:00.000Z",
    });
    await Promise.resolve();

    expect(patch).toHaveBeenCalledTimes(3);

    controller.write({
      environmentId: primaryEnvironmentId,
      value: "t3",
      serverPreferences: previous,
      canPatch: true,
      now: "2026-08-14T12:03:00.000Z",
      patch,
      persist: hydrationInput.persist,
    });
    await Promise.resolve();

    expect(patch).toHaveBeenCalledTimes(4);
    controller.reset();
  });

  it("does not retry or persist a failed patch after changing primaries", async () => {
    const previousPrimaryEnvironmentId = EnvironmentId.make("previous-primary");
    const nextPrimaryEnvironmentId = EnvironmentId.make("next-primary");
    const scheduledRetries: Array<() => void> = [];
    const controller = createSyncedPlanModeHydrationController((retry) => {
      let cancelled = false;
      scheduledRetries.push(() => {
        if (!cancelled) retry();
      });
      return () => {
        cancelled = true;
      };
    });
    const patch = vi
      .fn<SyncedPlanModeHydrationInput<string>["patch"]>()
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail("offline")))
      .mockResolvedValue(
        AsyncResult.success({
          planModeEnabled: true,
          updatedAt: "2026-08-14T12:02:00.000Z",
        }),
      );
    const persist = vi.fn();
    const input = {
      environmentId: previousPrimaryEnvironmentId,
      primaryEnvironmentId: previousPrimaryEnvironmentId,
      clientHydrated: true,
      clientValue: false,
      live: true,
      serverPreferences: undefined,
      canPatch: true,
      now: "2026-08-14T12:00:00.000Z",
      patch,
      persist,
    } satisfies SyncedPlanModeHydrationInput<string>;
    const owner = Symbol();
    const deactivate = controller.synchronize(input, owner);
    await Promise.resolve();
    expect(scheduledRetries).toHaveLength(1);

    deactivate?.();
    controller.synchronize(
      {
        ...input,
        environmentId: nextPrimaryEnvironmentId,
        primaryEnvironmentId: nextPrimaryEnvironmentId,
        serverPreferences: {
          planModeEnabled: false,
          updatedAt: "2026-08-14T12:01:00.000Z",
        },
      },
      owner,
    );
    scheduledRetries[0]?.();
    await Promise.resolve();

    expect(patch).toHaveBeenCalledOnce();
    expect(persist).not.toHaveBeenCalled();
  });

  it.each([
    { switchPrimary: true, expectedPersisted: [] },
    { switchPrimary: false, expectedPersisted: [true] },
  ])(
    "persists a successful patch only while its environment remains active ($switchPrimary)",
    async ({ switchPrimary, expectedPersisted }) => {
      const previousPrimaryEnvironmentId = EnvironmentId.make("previous-primary");
      const nextPrimaryEnvironmentId = EnvironmentId.make("next-primary");
      const controller = createSyncedPlanModeHydrationController();
      let resolvePatch!: (
        result: Awaited<ReturnType<SyncedPlanModeHydrationInput<never>["patch"]>>,
      ) => void;
      const patch = vi.fn<SyncedPlanModeHydrationInput<never>["patch"]>(
        () =>
          new Promise((resolve) => {
            resolvePatch = resolve;
          }),
      );
      const persisted: boolean[] = [];
      const persist = (value: boolean) => persisted.push(value);
      const input = {
        environmentId: previousPrimaryEnvironmentId,
        primaryEnvironmentId: previousPrimaryEnvironmentId,
        clientHydrated: true,
        clientValue: true,
        live: true,
        serverPreferences: undefined,
        canPatch: true,
        now: "2026-08-14T12:00:00.000Z",
        patch,
        persist,
      } satisfies SyncedPlanModeHydrationInput<never>;
      const owner = Symbol();
      const deactivate = controller.synchronize(input, owner);
      expect(patch).toHaveBeenCalledOnce();

      if (switchPrimary) {
        deactivate?.();
        controller.synchronize(
          {
            ...input,
            environmentId: nextPrimaryEnvironmentId,
            primaryEnvironmentId: nextPrimaryEnvironmentId,
            clientValue: false,
            serverPreferences: {
              planModeEnabled: false,
              updatedAt: "2026-08-14T12:01:00.000Z",
            },
          },
          owner,
        );
      }

      resolvePatch(
        AsyncResult.success({
          planModeEnabled: true,
          updatedAt: "2026-08-14T12:00:00.000Z",
        }),
      );
      await Promise.resolve();

      expect(persisted).toEqual(expectedPersisted);
      if (!switchPrimary) deactivate?.();
    },
  );

  it("does not adopt stale shell preferences after an inactive patch settles", async () => {
    const environmentId = EnvironmentId.make("primary");
    const controller = createSyncedPlanModeHydrationController();
    const previous = {
      planModeEnabled: false,
      updatedAt: "2026-08-14T12:00:00.000Z",
    } as const;
    const stale = {
      planModeEnabled: false,
      updatedAt: "2026-08-14T12:01:00.000Z",
    } as const;
    let resolvePatch!: (
      result: Awaited<ReturnType<SyncedPlanModeHydrationInput<never>["patch"]>>,
    ) => void;
    const patch = vi.fn<SyncedPlanModeHydrationInput<never>["patch"]>(
      () =>
        new Promise((resolve) => {
          resolvePatch = resolve;
        }),
    );
    let localValue = false;
    const persisted: boolean[] = [];
    const persist = (value: boolean) => {
      localValue = value;
      persisted.push(value);
    };
    const deactivate = controller.synchronize({
      environmentId,
      primaryEnvironmentId: environmentId,
      clientHydrated: true,
      clientValue: localValue,
      live: true,
      serverPreferences: previous,
      canPatch: true,
      now: previous.updatedAt,
      patch,
      persist,
    });

    localValue = true;
    controller.write({
      environmentId,
      value: localValue,
      serverPreferences: previous,
      canPatch: true,
      now: "2026-08-14T12:02:00.000Z",
      patch,
      persist,
    });
    deactivate?.();
    resolvePatch(
      AsyncResult.success({
        planModeEnabled: true,
        updatedAt: "2026-08-14T12:02:00.000Z",
      }),
    );
    await Promise.resolve();

    expect(persisted).toEqual([]);

    controller.synchronize({
      environmentId,
      primaryEnvironmentId: environmentId,
      clientHydrated: true,
      clientValue: localValue,
      live: true,
      serverPreferences: stale,
      canPatch: true,
      now: "2026-08-14T12:03:00.000Z",
      patch,
      persist,
    });

    expect(localValue).toBe(true);
    expect(persisted).toEqual([]);
    expect(patch).toHaveBeenCalledOnce();
  });

  it("keeps the latest rapid toggle when responses settle out of order", async () => {
    const primaryEnvironmentId = EnvironmentId.make("primary");
    const controller = createSyncedPlanModeHydrationController();
    const previous = {
      planModeEnabled: false,
      updatedAt: "2026-08-14T12:00:00.000Z",
    } as const;
    const targets: Array<Parameters<SyncedPlanModeHydrationInput<never>["patch"]>[0]> = [];
    const resolvePatches: Array<
      (result: Awaited<ReturnType<SyncedPlanModeHydrationInput<never>["patch"]>>) => void
    > = [];
    const patch: SyncedPlanModeHydrationInput<never>["patch"] = (target) =>
      new Promise((resolve) => {
        targets.push(target);
        resolvePatches.push(resolve);
      });
    const persisted: boolean[] = [];
    const persist = (value: boolean) => persisted.push(value);

    controller.synchronize({
      environmentId: primaryEnvironmentId,
      primaryEnvironmentId,
      clientHydrated: true,
      clientValue: false,
      live: true,
      serverPreferences: previous,
      canPatch: true,
      now: previous.updatedAt,
      patch,
      persist,
    });
    controller.write({
      environmentId: primaryEnvironmentId,
      value: true,
      serverPreferences: previous,
      canPatch: true,
      now: previous.updatedAt,
      patch,
      persist,
    });
    controller.write({
      environmentId: primaryEnvironmentId,
      value: false,
      serverPreferences: previous,
      canPatch: true,
      now: previous.updatedAt,
      patch,
      persist,
    });

    expect(targets.map((target) => target.input.updatedAt)).toEqual([
      "2026-08-14T12:00:00.001Z",
      "2026-08-14T12:00:00.002Z",
    ]);
    resolvePatches[1]?.(
      AsyncResult.success({ planModeEnabled: false, updatedAt: targets[1]!.input.updatedAt }),
    );
    await Promise.resolve();
    resolvePatches[0]?.(
      AsyncResult.success({ planModeEnabled: true, updatedAt: targets[0]!.input.updatedAt }),
    );
    await Promise.resolve();

    expect(persisted).toEqual([false]);
  });

  it("ignores a seed acknowledgement after a newer write is queued", async () => {
    const primaryEnvironmentId = EnvironmentId.make("primary");
    const controller = createSyncedPlanModeHydrationController();
    const targets: Array<Parameters<SyncedPlanModeHydrationInput<never>["patch"]>[0]> = [];
    const resolvePatches: Array<
      (result: Awaited<ReturnType<SyncedPlanModeHydrationInput<never>["patch"]>>) => void
    > = [];
    const patch: SyncedPlanModeHydrationInput<never>["patch"] = (target) =>
      new Promise((resolve) => {
        targets.push(target);
        resolvePatches.push(resolve);
      });
    const persisted: boolean[] = [];
    const persist = (value: boolean) => persisted.push(value);

    controller.synchronize({
      environmentId: primaryEnvironmentId,
      primaryEnvironmentId,
      clientHydrated: true,
      clientValue: false,
      live: true,
      serverPreferences: undefined,
      canPatch: true,
      now: "2026-08-14T12:00:00.000Z",
      patch,
      persist,
    });
    controller.write({
      environmentId: primaryEnvironmentId,
      value: true,
      serverPreferences: undefined,
      canPatch: true,
      now: "2026-08-14T12:01:00.000Z",
      patch,
      persist,
    });

    resolvePatches[0]?.(
      AsyncResult.success({ planModeEnabled: false, updatedAt: targets[0]!.input.updatedAt }),
    );
    await Promise.resolve();
    expect(persisted).toEqual([]);

    resolvePatches[1]?.(
      AsyncResult.success({ planModeEnabled: true, updatedAt: targets[1]!.input.updatedAt }),
    );
    await Promise.resolve();
    expect(persisted).toEqual([true]);
  });

  it("keeps the synced preference atom stable across thread-only shell updates", () => {
    const preferences = {
      planModeEnabled: true,
      updatedAt: "2026-08-14T12:00:00.000Z",
    } as const;
    const shellStateAtom = Atom.make<EnvironmentShellState>({
      status: "live",
      error: Option.none(),
      snapshot: Option.some({
        snapshotSequence: 1,
        projects: [],
        threads: [],
        updatedAt: "2026-08-14T12:00:00.000Z",
        syncedClientPreferences: preferences,
      }),
    });
    const sliceAtom = createSyncedClientPreferencesSliceAtom(shellStateAtom);
    const registry = AtomRegistry.make();
    const unmount = registry.mount(sliceAtom);
    const first = registry.get(sliceAtom);

    registry.set(shellStateAtom, {
      status: "live",
      error: Option.none(),
      snapshot: Option.some({
        snapshotSequence: 2,
        projects: [],
        threads: [],
        updatedAt: "2026-08-14T12:00:01.000Z",
        syncedClientPreferences: preferences,
      }),
    });

    expect(registry.get(sliceAtom)).toBe(first);
    unmount();
  });
});
