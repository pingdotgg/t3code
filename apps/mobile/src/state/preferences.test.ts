import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

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
    layer: Layer.empty,
  };
});

import { createMobilePreferencesState } from "./preferences";
import { useAtomCommand } from "./use-atom-command";
import * as MobilePreferences from "../persistence/mobile-preferences";

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((resume) => {
    resolve = resume;
  });
  return { promise, resolve } as const;
}

function makePreferencesState(
  service: Omit<MobilePreferences.MobilePreferencesStore["Service"], "update"> &
    Partial<Pick<MobilePreferences.MobilePreferencesStore["Service"], "update">>,
) {
  const completeService = MobilePreferences.MobilePreferencesStore.of({
    ...service,
    update:
      service.update ??
      ((transform) =>
        service.load.pipe(
          Effect.flatMap((current) => service.savePatch(transform(current))),
          Effect.mapError((cause) =>
            cause._tag === "MobilePreferencesSaveError"
              ? cause
              : new MobilePreferences.MobilePreferencesSaveError({ cause }),
          ),
        )),
  });
  return createMobilePreferencesState(
    Atom.runtime(Layer.succeed(MobilePreferences.MobilePreferencesStore, completeService)),
  );
}

describe("mobile preferences state", () => {
  it.effect("preserves an optimistic patch when the initial load finishes later", () =>
    Effect.gen(function* () {
      const pendingLoad = deferred<MobilePreferences.Preferences>();
      const savePatch = vi.fn((patch: Partial<MobilePreferences.Preferences>) =>
        Effect.succeed(patch),
      );
      const state = makePreferencesState({
        load: Effect.promise(() => pendingLoad.promise),
        savePatch,
      });
      const registry = AtomRegistry.make();
      const unmountPreferences = registry.mount(state.preferencesAtom);

      const save = state.savePreferences.run(registry, {
        collapsedProjectGroups: ["project:new"],
      });
      pendingLoad.resolve({
        baseFontSize: 18,
        collapsedProjectGroups: ["project:old"],
      });

      const preferences = yield* AtomRegistry.getResult(registry, state.preferencesAtom, {
        suspendOnWaiting: true,
      });
      const saveResult = yield* Effect.promise(() => save);
      expect(preferences).toEqual({
        baseFontSize: 18,
        collapsedProjectGroups: ["project:new"],
      });
      expect(savePatch).toHaveBeenCalledWith({
        collapsedProjectGroups: ["project:new"],
      });
      expect(AsyncResult.isFailure(saveResult)).toBe(false);

      unmountPreferences();
      registry.dispose();
    }),
  );

  it.effect("keeps both favorites when the React command sends updates before a render", () =>
    Effect.gen(function* () {
      let persisted: MobilePreferences.Preferences = { modelFavorites: [] };
      const state = makePreferencesState({
        load: Effect.succeed(persisted),
        savePatch: (patch) =>
          Effect.sync(() => {
            persisted = { ...persisted, ...patch };
            return persisted;
          }),
        update: (transform) =>
          Effect.sync(() => {
            persisted = { ...persisted, ...transform(persisted) };
            return persisted;
          }),
      });
      const registry = AtomRegistry.make();
      const unmountPreferences = registry.mount(state.preferencesAtom);
      yield* AtomRegistry.getResult(registry, state.preferencesAtom, { suspendOnWaiting: true });

      function useSavePreferences() {
        return useAtomCommand(state.savePreferences, { reportFailure: false });
      }
      const setters: Array<ReturnType<typeof useSavePreferences>> = [];
      function CaptureSetter() {
        setters.push(useSavePreferences());
        return null;
      }
      renderToString(
        createElement(RegistryContext.Provider, { value: registry }, createElement(CaptureSetter)),
      );
      const savePreferences = setters[0]!;
      const provider = ProviderInstanceId.make("codex");
      const first = savePreferences({
        transform: (current) => ({
          modelFavorites: [...(current.modelFavorites ?? []), { provider, model: "astra" }],
        }),
      });
      const second = savePreferences({
        transform: (current) => ({
          modelFavorites: [...(current.modelFavorites ?? []), { provider, model: "sol" }],
        }),
      });
      yield* Effect.promise(() => Promise.all([first, second]));

      expect(persisted.modelFavorites).toEqual([
        { provider, model: "astra" },
        { provider, model: "sol" },
      ]);

      yield* Effect.promise(() =>
        savePreferences({
          transform: (current) => ({
            modelFavorites: (current.modelFavorites ?? []).filter(
              (favorite) => favorite.model !== "astra",
            ),
          }),
        }),
      );
      expect(persisted.modelFavorites).toEqual([{ provider, model: "sol" }]);

      unmountPreferences();
      registry.dispose();
    }),
  );

  it.effect("stages optimistically only when run, and clears the patch on interrupt", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const state = makePreferencesState({
        load: Effect.succeed({ baseFontSize: 16 }),
        savePatch: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const registry = AtomRegistry.make();
      const unmount = registry.mount(state.preferencesAtom);
      yield* AtomRegistry.getResult(registry, state.preferencesAtom, { suspendOnWaiting: true });

      // Building the Effect must not mutate optimistic state before it runs.
      const effect = state.save({ baseFontSize: 20 }, registry);
      expect(AsyncResult.getOrElse(registry.get(state.preferencesAtom), () => ({}))).toEqual({
        baseFontSize: 16,
      });

      const fiber = yield* Effect.forkChild(
        effect.pipe(
          Effect.provide(
            Layer.succeed(
              MobilePreferences.MobilePreferencesStore,
              MobilePreferences.MobilePreferencesStore.of({
                load: Effect.succeed({ baseFontSize: 16 }),
                savePatch: () =>
                  Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
                update: () => Effect.die("unexpected"),
              }),
            ),
          ),
        ),
      );
      yield* Deferred.await(started);
      expect(AsyncResult.getOrElse(registry.get(state.preferencesAtom), () => ({}))).toEqual({
        baseFontSize: 20,
      });

      yield* Fiber.interrupt(fiber);
      expect(AsyncResult.getOrElse(registry.get(state.preferencesAtom), () => ({}))).toEqual({
        baseFontSize: 16,
      });

      unmount();
      registry.dispose();
    }),
  );

  it.effect("reports each overlapping save's own outcome", () =>
    Effect.gen(function* () {
      const slowSave = deferred<void>();
      const state = makePreferencesState({
        load: Effect.succeed({}),
        savePatch: (patch) =>
          "baseFontSize" in patch
            ? Effect.promise(() => slowSave.promise).pipe(
                Effect.andThen(
                  Effect.fail(
                    new MobilePreferences.MobilePreferencesSaveError({
                      cause: new Error("secure storage unavailable"),
                    }),
                  ),
                ),
              )
            : Effect.succeed(patch),
      });
      const registry = AtomRegistry.make();
      const unmount = registry.mount(state.preferencesAtom);

      const failing = state.savePreferences.run(registry, { baseFontSize: 18 });
      const succeeding = state.savePreferences.run(registry, { crashReportsEnabled: false });
      slowSave.resolve();

      expect((yield* Effect.promise(() => succeeding))._tag).toBe("Success");
      expect((yield* Effect.promise(() => failing))._tag).toBe("Failure");

      unmount();
      registry.dispose();
    }),
  );

  it.effect("falls back to empty preferences when secure storage cannot be read", () =>
    Effect.gen(function* () {
      const state = makePreferencesState({
        load: Effect.fail(
          new MobilePreferences.MobilePreferencesLoadError({
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
});
