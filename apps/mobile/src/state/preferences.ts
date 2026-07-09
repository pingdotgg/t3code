import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { loadPreferences, savePreferencesPatch, type Preferences } from "../lib/storage";

export class MobilePreferencesLoadError extends Schema.TaggedErrorClass<MobilePreferencesLoadError>()(
  "MobilePreferencesLoadError",
  { cause: Schema.Defect() },
) {}

export class MobilePreferencesSaveError extends Schema.TaggedErrorClass<MobilePreferencesSaveError>()(
  "MobilePreferencesSaveError",
  { cause: Schema.Defect() },
) {}

export class MobilePreferencesStore extends Context.Service<
  MobilePreferencesStore,
  {
    readonly load: Effect.Effect<Preferences, MobilePreferencesLoadError>;
    readonly savePatch: (
      patch: Partial<Preferences>,
    ) => Effect.Effect<Preferences, MobilePreferencesSaveError>;
  }
>()("@t3tools/mobile/state/preferences/MobilePreferencesStore") {
  static readonly layer = Layer.succeed(
    MobilePreferencesStore,
    MobilePreferencesStore.of({
      load: Effect.tryPromise({
        try: loadPreferences,
        catch: (cause) => new MobilePreferencesLoadError({ cause }),
      }),
      savePatch: Effect.fn("MobilePreferencesStore.savePatch")((patch) =>
        Effect.tryPromise({
          try: () => savePreferencesPatch(patch),
          catch: (cause) => new MobilePreferencesSaveError({ cause }),
        }),
      ),
    }),
  );
}

interface OptimisticPreferences {
  readonly values: Partial<Preferences>;
  readonly versions: Partial<Record<keyof Preferences, number>>;
}

/**
 * Owns the device preference blob for the lifetime of the app registry.
 * Optimistic patches are kept separately so writes made while persistence is
 * still loading cannot be replaced by the eventual read result.
 */
export function createMobilePreferencesState(runtime: Atom.AtomRuntime<MobilePreferencesStore>) {
  const storedPreferencesAtom = runtime
    .atom(
      MobilePreferencesStore.pipe(
        Effect.flatMap((store) => store.load),
        Effect.catch((error) =>
          Effect.logWarning("Could not load mobile preferences.", error).pipe(
            Effect.as<Preferences>({}),
          ),
        ),
      ),
    )
    .pipe(Atom.keepAlive, Atom.withLabel("mobile:preferences:stored"));

  const optimisticPatchAtom = Atom.make<OptimisticPreferences>({ values: {}, versions: {} }).pipe(
    Atom.keepAlive,
    Atom.withLabel("mobile:preferences:optimistic-patch"),
  );
  const confirmedPreferencesAtom = Atom.make<Preferences>({}).pipe(
    Atom.keepAlive,
    Atom.withLabel("mobile:preferences:confirmed"),
  );
  let nextPatchVersion = 0;

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

  const updatePreferencesAtom = runtime
    .fn(
      (patch: Partial<Preferences>, get) => {
        const version = ++nextPatchVersion;
        const current = get(optimisticPatchAtom);
        const versions = { ...current.versions };
        for (const key of Object.keys(patch) as Array<keyof Preferences>) {
          versions[key] = version;
        }
        get.set(optimisticPatchAtom, {
          values: { ...current.values, ...patch },
          versions,
        });
        return MobilePreferencesStore.pipe(
          Effect.flatMap((store) => store.savePatch(patch)),
          Effect.tap((saved) =>
            Effect.sync(() => {
              get.set(confirmedPreferencesAtom, saved);
              const optimistic = get(optimisticPatchAtom);
              const values = { ...optimistic.values } as Record<string, unknown>;
              const currentVersions = { ...optimistic.versions } as Record<string, unknown>;
              for (const key of Object.keys(patch) as Array<keyof Preferences>) {
                if (optimistic.versions[key] === version) {
                  delete values[key];
                  delete currentVersions[key];
                }
              }
              get.set(optimisticPatchAtom, {
                values: values as Partial<Preferences>,
                versions: currentVersions as Partial<Record<keyof Preferences, number>>,
              });
            }),
          ),
          Effect.tapError(() =>
            Effect.sync(() => {
              const optimistic = get(optimisticPatchAtom);
              const values = { ...optimistic.values } as Record<string, unknown>;
              const currentVersions = { ...optimistic.versions } as Record<string, unknown>;
              for (const key of Object.keys(patch) as Array<keyof Preferences>) {
                if (optimistic.versions[key] === version) {
                  delete values[key];
                  delete currentVersions[key];
                }
              }
              get.set(optimisticPatchAtom, {
                values: values as Partial<Preferences>,
                versions: currentVersions as Partial<Record<keyof Preferences, number>>,
              });
            }),
          ),
        );
      },
      // The storage layer serializes preference read-modify-write operations.
      // Keep every invocation alive so one preference update cannot interrupt
      // another update to a different field in the shared blob.
      { concurrent: true },
    )
    .pipe(Atom.keepAlive, Atom.withLabel("mobile:preferences:update"));

  return { preferencesAtom, updatePreferencesAtom } as const;
}

const mobilePreferencesRuntime = Atom.runtime(MobilePreferencesStore.layer);
export const mobilePreferencesState = createMobilePreferencesState(mobilePreferencesRuntime);

export const mobilePreferencesAtom = mobilePreferencesState.preferencesAtom;
export const updateMobilePreferencesAtom = mobilePreferencesState.updatePreferencesAtom;
