import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";
import { RegistryContext, useAtomSet } from "@effect/atom-react";
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
import {
  createChangeRequestTermsAtom,
  installChangeRequestTerminologyRuntime,
} from "./change-request-terminology";
import {
  currentChangeRequestTerms,
  setMergeRequestTerms,
} from "@t3tools/client-runtime/source-control-clients";
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
      const termsAtom = createChangeRequestTermsAtom(state.preferencesAtom);
      const unmountTerms = registry.mount(termsAtom);
      expect(registry.get(termsAtom).shortLabel).toBe("PR");
      const unmountPreferences = registry.mount(state.preferencesAtom);
      const unmountUpdate = registry.mount(state.updatePreferencesAtom);

      registry.set(state.updatePreferencesAtom, {
        collapsedProjectGroups: ["project:new"],
        mergeRequestTerminology: true,
      });
      pendingLoad.resolve({
        baseFontSize: 18,
        collapsedProjectGroups: ["project:old"],
        mergeRequestTerminology: false,
      });

      const preferences = yield* AtomRegistry.getResult(registry, state.preferencesAtom, {
        suspendOnWaiting: true,
      });
      expect(preferences).toEqual({
        baseFontSize: 18,
        collapsedProjectGroups: ["project:new"],
        mergeRequestTerminology: true,
      });
      expect(savePatch).toHaveBeenCalledWith({
        collapsedProjectGroups: ["project:new"],
        mergeRequestTerminology: true,
      });
      expect(registry.get(termsAtom).shortLabel).toBe("MR");

      registry.set(state.updatePreferencesAtom, { mergeRequestTerminology: false });
      yield* AtomRegistry.getResult(registry, state.updatePreferencesAtom, {
        suspendOnWaiting: true,
      });
      expect(registry.get(termsAtom).shortLabel).toBe("PR");
      expect(AsyncResult.isFailure(registry.get(state.updatePreferencesAtom))).toBe(false);

      unmountUpdate();
      unmountPreferences();
      unmountTerms();
      registry.dispose();
    }),
  );

  it.effect("restores saved terminology and rolls back a failed change", () =>
    Effect.gen(function* () {
      const pendingSave = deferred<void>();
      const state = makePreferencesState({
        load: Effect.succeed({ mergeRequestTerminology: true }),
        savePatch: () =>
          Effect.promise(() => pendingSave.promise).pipe(
            Effect.andThen(
              Effect.fail(
                new MobilePreferences.MobilePreferencesSaveError({
                  cause: new Error("storage unavailable"),
                }),
              ),
            ),
          ),
      });
      const registry = AtomRegistry.make();
      const termsAtom = createChangeRequestTermsAtom(state.preferencesAtom);
      const stopTerminology = installChangeRequestTerminologyRuntime(registry, termsAtom);
      try {
        yield* AtomRegistry.getResult(registry, state.preferencesAtom, { suspendOnWaiting: true });
        expect(registry.get(termsAtom).shortLabel).toBe("MR");
        registry.set(state.updatePreferencesAtom, { mergeRequestTerminology: false });
        expect(registry.get(termsAtom).shortLabel).toBe("PR");
        pendingSave.resolve();
        yield* AtomRegistry.getResult(registry, state.updatePreferencesAtom, {
          suspendOnWaiting: true,
        }).pipe(Effect.exit);
        expect(registry.get(termsAtom).shortLabel).toBe("MR");
        expect(currentChangeRequestTerms().shortLabel).toBe("MR");
      } finally {
        stopTerminology();
        registry.dispose();
        setMergeRequestTerms(false);
      }
    }),
  );

  it.effect("keeps both favorites when the React setter sends updates before a render", () =>
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
      const unmountUpdate = registry.mount(state.updatePreferencesAtom);
      yield* AtomRegistry.getResult(registry, state.preferencesAtom, { suspendOnWaiting: true });

      function useSavePreferences() {
        return useAtomSet(state.updatePreferencesAtom);
      }
      const setters: Array<ReturnType<typeof useSavePreferences>> = [];
      function CaptureSetter() {
        setters.push(useSavePreferences());
        return null;
      }
      // Use the React setter; registry.set bypasses bare-function update semantics.
      renderToString(
        createElement(RegistryContext.Provider, { value: registry }, createElement(CaptureSetter)),
      );
      const savePreferences = setters[0]!;
      const provider = ProviderInstanceId.make("codex");
      savePreferences({
        transform: (current) => ({
          modelFavorites: [...(current.modelFavorites ?? []), { provider, model: "astra" }],
        }),
      });
      savePreferences({
        transform: (current) => ({
          modelFavorites: [...(current.modelFavorites ?? []), { provider, model: "sol" }],
        }),
      });
      yield* AtomRegistry.getResult(registry, state.updatePreferencesAtom, {
        suspendOnWaiting: true,
      });

      expect(persisted.modelFavorites).toEqual([
        { provider, model: "astra" },
        { provider, model: "sol" },
      ]);

      savePreferences({
        transform: (current) => ({
          modelFavorites: (current.modelFavorites ?? []).filter(
            (favorite) => favorite.model !== "astra",
          ),
        }),
      });
      yield* AtomRegistry.getResult(registry, state.updatePreferencesAtom, {
        suspendOnWaiting: true,
      });
      expect(persisted.modelFavorites).toEqual([{ provider, model: "sol" }]);

      unmountUpdate();
      unmountPreferences();
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
