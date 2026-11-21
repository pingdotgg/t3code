import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import * as MobilePreferences from "../persistence/mobile-preferences";
import * as Runtime from "../lib/runtime";

interface OptimisticPreferences {
  readonly values: Partial<MobilePreferences.Preferences>;
  readonly versions: Partial<Record<keyof MobilePreferences.Preferences, number>>;
}

type PreferencesUpdate =
  | Partial<MobilePreferences.Preferences>
  | {
      readonly transform: (
        current: MobilePreferences.Preferences,
      ) => Partial<MobilePreferences.Preferences>;
    };

/** Keep optimistic patches separate so hydration cannot overwrite pending writes. */
export function createMobilePreferencesState(
  runtime: Atom.AtomRuntime<MobilePreferences.MobilePreferencesStore>,
) {
  const storedPreferencesAtom = runtime
    .atom(
      MobilePreferences.MobilePreferencesStore.pipe(
        Effect.flatMap((store) => store.load),
        Effect.catch((error) =>
          Effect.logWarning("Could not load mobile preferences.", error).pipe(
            Effect.as<MobilePreferences.Preferences>({}),
          ),
        ),
      ),
    )
    .pipe(Atom.keepAlive, Atom.withLabel("mobile:preferences:stored"));

  const optimisticPatchAtom = Atom.make<OptimisticPreferences>({ values: {}, versions: {} }).pipe(
    Atom.keepAlive,
    Atom.withLabel("mobile:preferences:optimistic-patch"),
  );
  const confirmedPreferencesAtom = Atom.make<MobilePreferences.Preferences>({}).pipe(
    Atom.keepAlive,
    Atom.withLabel("mobile:preferences:confirmed"),
  );
  let nextPatchVersion = 0;

  // Restarting for an optimistic language change can interrupt the storage write.
  const savedLanguageAtom = Atom.make((get) => {
    const confirmed = get(confirmedPreferencesAtom);
    return AsyncResult.map(
      get(storedPreferencesAtom),
      (stored) => confirmed.language ?? stored.language,
    );
  });

  const preferencesAtom = Atom.make((get) => {
    const stored = get(storedPreferencesAtom);
    const confirmed = get(confirmedPreferencesAtom);
    const optimistic = get(optimisticPatchAtom);
    return AsyncResult.map(stored, (preferences) => ({
      ...preferences,
      ...confirmed,
      ...optimistic.values,
    }));
  }).pipe(Atom.keepAlive, Atom.withLabel("mobile:preferences"));

  const settlePatch = (
    registry: AtomRegistry.AtomRegistry,
    patch: Partial<MobilePreferences.Preferences>,
    version: number,
  ) => {
    const optimistic = registry.get(optimisticPatchAtom);
    const values = { ...optimistic.values } as Record<string, unknown>;
    const versions = { ...optimistic.versions } as Record<string, unknown>;
    for (const key of Object.keys(patch) as Array<keyof MobilePreferences.Preferences>) {
      if (optimistic.versions[key] === version) {
        delete values[key];
        delete versions[key];
      }
    }
    registry.set(optimisticPatchAtom, {
      values: values as Partial<MobilePreferences.Preferences>,
      versions: versions as Partial<Record<keyof MobilePreferences.Preferences, number>>,
    });
  };

  // The optimistic patch lands when a save starts, before the store finishes writing.
  const stage = (update: PreferencesUpdate, registry: AtomRegistry.AtomRegistry) => {
    const currentPreferences = registry.get(preferencesAtom);
    const patch =
      "transform" in update
        ? update.transform(
            AsyncResult.isSuccess(currentPreferences) ? currentPreferences.value : {},
          )
        : update;
    const version = ++nextPatchVersion;
    const current = registry.get(optimisticPatchAtom);
    const versions = { ...current.versions };
    for (const key of Object.keys(patch) as Array<keyof MobilePreferences.Preferences>) {
      versions[key] = version;
    }
    registry.set(optimisticPatchAtom, { values: { ...current.values, ...patch }, versions });
    return { patch, version } as const;
  };

  const save = Effect.fn("MobilePreferencesState.save")(function* (
    update: PreferencesUpdate,
    registry: AtomRegistry.AtomRegistry,
  ) {
    const store = yield* MobilePreferences.MobilePreferencesStore;
    const staged = yield* Effect.sync(() => stage(update, registry));
    return yield* (
      "transform" in update ? store.update(update.transform) : store.savePatch(staged.patch)
    ).pipe(
      Effect.tap((saved) => Effect.sync(() => registry.set(confirmedPreferencesAtom, saved))),
      Effect.ensuring(Effect.sync(() => settlePatch(registry, staged.patch, staged.version))),
    );
  });

  // One command gives every caller its own settled result, even when saves overlap.
  const savePreferences = createRuntimeCommand(runtime, {
    label: "mobile:preferences:save",
    execute: save,
  });

  return { preferencesAtom, save, savePreferences, savedLanguageAtom } as const;
}

const mobilePreferencesRuntime = Atom.runtime(Runtime.layer);
const mobilePreferencesState = createMobilePreferencesState(mobilePreferencesRuntime);

export const mobilePreferencesAtom = mobilePreferencesState.preferencesAtom;
export const savedMobileLanguageAtom = mobilePreferencesState.savedLanguageAtom;
export const saveMobilePreferences = mobilePreferencesState.savePreferences;
