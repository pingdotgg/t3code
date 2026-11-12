import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { type UiLocale } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry, subscribeAtomChanges } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom, serverEnvironment } from "../state/server";

export function useUiLocale(): UiLocale {
  return useAtomValue(activeUiLocaleAtom);
}

/**
 * Several environments may be connected; the first explicit uiLocale wins,
 * "system" follows the device language. Mirrors mobile's resolveActiveUiLocale.
 */
export const activeUiLocaleAtom = Atom.make((get): UiLocale => {
  for (const config of get(environmentServerConfigsAtom).values()) {
    if (config.settings.uiLocale !== "system") return config.settings.uiLocale;
  }
  return "system";
});

/** Syncs the callback with each active-ui-locale change; fires immediately with the current value. */
export function subscribeActiveUiLocale(listener: (uiLocale: UiLocale) => void): () => void {
  listener(appAtomRegistry.get(activeUiLocaleAtom));
  return subscribeAtomChanges(activeUiLocaleAtom, listener);
}

/** Writes the locale to every connected environment; the settingsUpdated push syncs other clients. */
export function writeUiLocale(uiLocale: UiLocale): void {
  for (const environmentId of appAtomRegistry.get(environmentServerConfigsAtom).keys()) {
    void runAtomCommand(appAtomRegistry, serverEnvironment.updateSettings, {
      environmentId,
      input: { patch: { uiLocale } },
    });
  }
}
