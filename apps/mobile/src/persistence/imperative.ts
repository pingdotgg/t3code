import * as Effect from "effect/Effect";

import { runtime } from "../lib/runtime";
import * as MobilePreferences from "./mobile-preferences";
import * as MobileStorage from "./mobile-storage";

export type { Preferences } from "./mobile-preferences";
export type { RecentThreadShortcut } from "./mobile-storage";
export { MobilePreferencesLoadError, MobilePreferencesSaveError } from "./mobile-preferences";
export {
  MobileDeviceIdGenerationError,
  MobileStorageDecodeError,
  MobileStorageEncodeError,
} from "./mobile-storage";
export { MobileSecureStorageError } from "./mobile-secure-storage";

const runStorage = <A, E>(
  use: (storage: MobileStorage.MobileStorage["Service"]) => Effect.Effect<A, E>,
) => runtime.runPromise(MobileStorage.MobileStorage.pipe(Effect.flatMap(use)));

const runPreferences = <A, E>(
  use: (store: MobilePreferences.MobilePreferencesStore["Service"]) => Effect.Effect<A, E>,
) => runtime.runPromise(MobilePreferences.MobilePreferencesStore.pipe(Effect.flatMap(use)));

export const loadPreferences = () => runPreferences((store) => store.load);
export const savePreferencesPatch = (patch: Partial<MobilePreferences.Preferences>) =>
  runPreferences((store) => store.savePatch(patch));
export const updatePreferences = (
  transform: (current: MobilePreferences.Preferences) => Partial<MobilePreferences.Preferences>,
) => runPreferences((store) => store.update(transform));

export const loadRecentThreadShortcuts = () =>
  runStorage((storage) => storage.loadRecentThreadShortcuts);
export const saveRecentThreadShortcuts = (
  threads: ReadonlyArray<MobileStorage.RecentThreadShortcut>,
) => runStorage((storage) => storage.saveRecentThreadShortcuts(threads));
