import {
  CUSTOM_THEME_KEY_PREFIX,
  isClientProfileBaseKey,
} from "@t3tools/client-runtime/client-profile/keys";
import { emptyClientProfileSidecar } from "@t3tools/client-runtime/client-profile/merge";
import { combineClientProfileSources } from "@t3tools/client-runtime/client-profile/source";
import {
  createClientProfileSync,
  type ClientProfileEnvironment,
} from "@t3tools/client-runtime/client-profile/sync";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { msg } from "gt-react-native";
import { Appearance } from "react-native";

import * as Dialog from "../components/ui/Dialog";
import { m } from "../i18n/messages";
import { subscribeRegisteredMobileThemes } from "../lib/mobileThemeRegistry";
import { uuidv4 } from "../lib/uuid";
import type { Preferences } from "../persistence/mobile-preferences";
import { appAtomRegistry } from "./atom-registry";
import { applyMobileProfileValues, readMobileProfileValues } from "./client-profile.logic";
import { createMobileEditorThemeSource } from "./editor-theme-source";
import { mobilePreferencesAtom, saveMobilePreferences } from "./preferences";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

function reportError(cause: unknown) {
  console.warn("[preferences-sync] failed", safeErrorLogAttributes(cause));
}

function loadedPreferences(): Preferences | undefined {
  const result = appAtomRegistry.get(mobilePreferencesAtom);
  return result._tag === "Success" ? result.value : undefined;
}

function preferencesReady(): Promise<Preferences> {
  const loaded = loadedPreferences();
  if (loaded !== undefined) return Promise.resolve(loaded);
  return new Promise((resolve) => {
    const unsubscribe = appAtomRegistry.subscribe(mobilePreferencesAtom, (result) => {
      if (result._tag !== "Success") return;
      unsubscribe();
      resolve(result.value);
    });
  });
}

// Writes are optimistic: the atom shows the patch at once and the store saves in call order.
function writePreferences(patch: Partial<Preferences>): Preferences {
  void runAtomCommand(appAtomRegistry, saveMobilePreferences, patch);
  return loadedPreferences() ?? {};
}

const environmentsAtom = Atom.make((get): ReadonlyArray<ClientProfileEnvironment> =>
  [...get(environmentPresentations.presentationsAtom).entries()].map(
    ([environmentId, presentation]) => ({
      environmentId,
      label: presentation.entry.target.label,
      connected: presentation.connection.phase === "connected",
      supportsProfile: presentation.serverConfig?.environment.capabilities.clientProfile === true,
      canWrite: get(serverEnvironment.updateClientProfile.permissionAtom(environmentId)),
      document: presentation.serverConfig?.clientProfile,
    }),
  ),
).pipe(Atom.withLabel("mobile:preferences-sync:environments"));

export const preferencesSync = createClientProfileSync({
  registry: appAtomRegistry,
  surface: { kind: "mobile" },
  environmentsAtom,
  push: async (environmentId, entries) => {
    const result = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.updateClientProfile,
      { environmentId: EnvironmentId.make(environmentId), input: { entries } },
      { reportFailure: false },
    );
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  },
  source: combineClientProfileSources([
    {
      owns: (base) =>
        isClientProfileBaseKey(base, { kind: "mobile" }) &&
        !base.startsWith(CUSTOM_THEME_KEY_PREFIX),
      ready: async () => {
        await preferencesReady();
      },
      read: () => ({
        values: readMobileProfileValues(loadedPreferences() ?? {}),
        completePrefixes: [],
      }),
      defaults: () => readMobileProfileValues({}),
      apply: async (values) =>
        applyMobileProfileValues({
          preferences: loadedPreferences() ?? {},
          values,
          systemAppearance: Appearance.getColorScheme() === "dark" ? "dark" : "light",
          write: writePreferences,
        }),
      subscribe: (onChange) => {
        const unsubscribePreferences = appAtomRegistry.subscribe(mobilePreferencesAtom, onChange);
        const unsubscribeThemes = subscribeRegisteredMobileThemes(onChange);
        return () => {
          unsubscribePreferences();
          unsubscribeThemes();
        };
      },
    },
    createMobileEditorThemeSource({
      load: () => loadedPreferences() ?? null,
      write: (editorThemes) => {
        writePreferences({ editorThemes });
      },
      subscribe: (onChange) => appAtomRegistry.subscribe(mobilePreferencesAtom, onChange),
    }),
  ]),
  sidecarStore: {
    load: async () => {
      const stored = (await preferencesReady()).clientProfileSync;
      if (stored !== undefined) return stored;
      const created = emptyClientProfileSidecar(uuidv4());
      writePreferences({ clientProfileSync: created });
      return created;
    },
    save: async (sidecar) => {
      writePreferences({ clientProfileSync: sidecar });
    },
  },
  onError: reportError,
});

function presentChoice() {
  Dialog.alert(
    m(msg("Sync preferences")),
    m(
      msg(
        "Other devices already sync preferences through your servers. Use synced settings: this device switches to the preferences your other devices share. Use this device's settings: all your devices switch to this device's preferences.",
      ),
    ),
    [
      {
        text: m(msg("Use synced settings")),
        onPress: () => void preferencesSync.choose("synced"),
      },
      {
        text: m(msg("Use this device's settings")),
        onPress: () => void preferencesSync.choose("thisDevice"),
      },
      {
        text: m(msg("Cancel")),
        style: "cancel",
        onPress: () => void preferencesSync.cancelChoice(),
      },
    ],
    { cancelable: false },
  );
}

export function installPreferencesSync(): () => void {
  const unsubscribeStatus = appAtomRegistry.subscribe(preferencesSync.statusAtom, (status) => {
    if (status.type === "choice") presentChoice();
  });
  const stop = preferencesSync.start();
  return () => {
    stop();
    unsubscribeStatus();
  };
}
