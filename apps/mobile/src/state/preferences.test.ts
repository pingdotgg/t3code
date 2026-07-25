import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

vi.mock("../lib/runtime", async () => {
  const Layer = await import("effect/Layer");
  return {
    runtime: { runPromise: vi.fn() },
    runtimeContextLayer: Layer.empty,
  };
});

import type { Preferences } from "../persistence/mobile-preferences";
import {
  createMobilePreferencesState,
  MobilePreferencesLoadError,
  MobilePreferencesSaveError,
  MobilePreferencesStore,
} from "./preferences";

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((resume) => {
    resolve = resume;
  });
  return { promise, resolve } as const;
}

function makePreferencesState(
  service: Omit<MobilePreferencesStore["Service"], "update"> &
    Partial<Pick<MobilePreferencesStore["Service"], "update">>,
) {
  const completeService = MobilePreferencesStore.of({
    ...service,
    update:
      service.update ??
      ((transform) =>
        service.load.pipe(
          Effect.flatMap((current) => service.savePatch(transform(current))),
          Effect.mapError((cause) =>
            cause._tag === "MobilePreferencesSaveError"
              ? cause
              : new MobilePreferencesSaveError({ cause }),
          ),
        )),
  });
  return createMobilePreferencesState(
    Atom.runtime(Layer.succeed(MobilePreferencesStore, completeService)),
  );
}

describe("mobile preferences state", () => {
  it.effect("shares one preference load across consumers", () =>
    Effect.gen(function* () {
      const load = vi.fn(() => Promise.resolve<Preferences>({ baseFontSize: 17 }));
      const state = makePreferencesState({
        load: Effect.promise(load),
        savePatch: (patch) => Effect.succeed(patch),
      });
      const registry = AtomRegistry.make();
      const unmountFirst = registry.mount(state.preferencesAtom);
      const unmountSecond = registry.mount(state.preferencesAtom);

      expect(
        yield* AtomRegistry.getResult(registry, state.preferencesAtom, {
          suspendOnWaiting: true,
        }),
      ).toEqual({ baseFontSize: 17 });
      expect(load).toHaveBeenCalledTimes(1);

      unmountSecond();
      unmountFirst();
      registry.dispose();
    }),
  );

  it.effect("preserves an optimistic patch when the initial load finishes later", () =>
    Effect.gen(function* () {
      const pendingLoad = deferred<Preferences>();
      const savePatch = vi.fn((patch: Partial<Preferences>) => Effect.succeed(patch));
      const state = makePreferencesState({
        load: Effect.promise(() => pendingLoad.promise),
        savePatch,
      });
      const registry = AtomRegistry.make();
      const unmountPreferences = registry.mount(state.preferencesAtom);
      const unmountUpdate = registry.mount(state.updatePreferencesAtom);

      registry.set(state.updatePreferencesAtom, {
        collapsedProjectGroups: ["project:new"],
      });
      pendingLoad.resolve({
        baseFontSize: 18,
        collapsedProjectGroups: ["project:old"],
      });

      const preferences = yield* AtomRegistry.getResult(registry, state.preferencesAtom, {
        suspendOnWaiting: true,
      });
      expect(preferences).toEqual({
        baseFontSize: 18,
        collapsedProjectGroups: ["project:new"],
      });
      expect(savePatch).toHaveBeenCalledWith({
        collapsedProjectGroups: ["project:new"],
      });
      expect(AsyncResult.isFailure(registry.get(state.updatePreferencesAtom))).toBe(false);

      unmountUpdate();
      unmountPreferences();
      registry.dispose();
    }),
  );

  it.effect("falls back to empty preferences when secure storage cannot be read", () =>
    Effect.gen(function* () {
      const state = makePreferencesState({
        load: Effect.fail(
          new MobilePreferencesLoadError({
            cause: new Error("secure storage unavailable"),
          }),
        ),
        savePatch: (patch) => Effect.succeed(patch),
      });
      const registry = AtomRegistry.make();
      const unmount = registry.mount(state.preferencesAtom);

      expect(
        yield* AtomRegistry.getResult(registry, state.preferencesAtom, {
          suspendOnWaiting: true,
        }),
      ).toEqual({});

      unmount();
      registry.dispose();
    }),
  );

  it.effect("does not roll back a newer optimistic write with the same value", () =>
    Effect.gen(function* () {
      let saveCount = 0;
      const state = makePreferencesState({
        load: Effect.succeed({ baseFontSize: 16, codeFontSize: 13 }),
        savePatch: (patch) => {
          saveCount += 1;
          return saveCount === 1
            ? Effect.fail(new MobilePreferencesSaveError({ cause: new Error("write failed") }))
            : Effect.succeed(patch);
        },
      });
      const registry = AtomRegistry.make();
      const unmountPreferences = registry.mount(state.preferencesAtom);
      const unmountUpdate = registry.mount(state.updatePreferencesAtom);

      yield* AtomRegistry.getResult(registry, state.preferencesAtom, {
        suspendOnWaiting: true,
      });
      registry.set(state.updatePreferencesAtom, { baseFontSize: 18 });
      registry.set(state.updatePreferencesAtom, { baseFontSize: 18, codeFontSize: 15 });

      yield* Effect.promise(() =>
        vi.waitFor(() => {
          expect(AsyncResult.isFailure(registry.get(state.updatePreferencesAtom))).toBe(false);
          expect(Option.getOrThrow(AsyncResult.value(registry.get(state.preferencesAtom)))).toEqual(
            {
              baseFontSize: 18,
              codeFontSize: 15,
            },
          );
        }),
      );

      unmountUpdate();
      unmountPreferences();
      registry.dispose();
    }),
  );

  it.effect("rolls back an optimistic field when its save fails", () =>
    Effect.gen(function* () {
      const state = makePreferencesState({
        load: Effect.succeed({ baseFontSize: 16 }),
        savePatch: () =>
          Effect.fail(new MobilePreferencesSaveError({ cause: new Error("write failed") })),
      });
      const registry = AtomRegistry.make();
      const unmountPreferences = registry.mount(state.preferencesAtom);
      const unmountUpdate = registry.mount(state.updatePreferencesAtom);

      yield* AtomRegistry.getResult(registry, state.preferencesAtom, {
        suspendOnWaiting: true,
      });
      registry.set(state.updatePreferencesAtom, { baseFontSize: 18 });

      yield* Effect.promise(() =>
        vi.waitFor(() => {
          expect(Option.getOrThrow(AsyncResult.value(registry.get(state.preferencesAtom)))).toEqual(
            {
              baseFontSize: 16,
            },
          );
        }),
      );

      unmountUpdate();
      unmountPreferences();
      registry.dispose();
    }),
  );

  it.effect("rolls back to the last confirmed value after a later save fails", () =>
    Effect.gen(function* () {
      let saveCount = 0;
      const state = makePreferencesState({
        load: Effect.succeed({ baseFontSize: 16 }),
        savePatch: () => {
          saveCount += 1;
          return saveCount === 1
            ? Effect.succeed({ baseFontSize: 14 })
            : Effect.fail(new MobilePreferencesSaveError({ cause: new Error("write failed") }));
        },
      });
      const registry = AtomRegistry.make();
      const unmountPreferences = registry.mount(state.preferencesAtom);
      const unmountUpdate = registry.mount(state.updatePreferencesAtom);

      yield* AtomRegistry.getResult(registry, state.preferencesAtom, {
        suspendOnWaiting: true,
      });
      registry.set(state.updatePreferencesAtom, { baseFontSize: 14 });
      yield* Effect.promise(() =>
        vi.waitFor(() => {
          expect(saveCount).toBe(1);
          expect(registry.get(state.updatePreferencesAtom).waiting).toBe(false);
          expect(Option.getOrThrow(AsyncResult.value(registry.get(state.preferencesAtom)))).toEqual(
            {
              baseFontSize: 14,
            },
          );
        }),
      );

      registry.set(state.updatePreferencesAtom, { baseFontSize: 18 });
      yield* Effect.promise(() =>
        vi.waitFor(() => {
          expect(saveCount).toBe(2);
          expect(Option.getOrThrow(AsyncResult.value(registry.get(state.preferencesAtom)))).toEqual(
            {
              baseFontSize: 14,
            },
          );
        }),
      );

      unmountUpdate();
      unmountPreferences();
      registry.dispose();
    }),
  );
});
