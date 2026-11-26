import { AsyncResult } from "effect/reactivity";
import { Platform } from "react-native";

import { appAtomRegistry } from "../state/atom-registry";
import { mobilePreferencesAtom } from "../state/preferences";

/** The Labs `enableAndroidBatterySaver` preference; always off outside Android. */
export function isAndroidBatterySaverEnabled(): boolean {
  if (Platform.OS !== "android") return false;
  const preferences = appAtomRegistry.get(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences) && preferences.value.enableAndroidBatterySaver === true;
}

export function subscribeAndroidBatterySaver(onChange: () => void): () => void {
  if (Platform.OS !== "android") return () => undefined;
  let enabled = isAndroidBatterySaverEnabled();
  return appAtomRegistry.subscribe(mobilePreferencesAtom, () => {
    const next = isAndroidBatterySaverEnabled();
    if (next === enabled) return;
    enabled = next;
    onChange();
  });
}
