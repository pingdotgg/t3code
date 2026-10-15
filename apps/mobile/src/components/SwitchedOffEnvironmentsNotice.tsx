import { useAtomValue } from "@effect/atom-react";
import {
  summarizeEnvironmentLabels,
  switchedOffSavedEnvironments,
} from "@t3tools/client-runtime/state/connections";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";
import { Alert } from "react-native";

import { environmentCatalog } from "../connection/catalog";
import { useAtomCommand } from "../state/use-atom-command";

const storageKey = "t3code.switched-off-environments-review.v1";
let shownThisLaunch = false;

/**
 * Asks once whether to switch saved computers back on. Older builds switched
 * computers off on their own when a host ran an incompatible version, and the
 * app cannot tell those apart from ones the user switched off.
 */
export function SwitchedOffEnvironmentsNotice() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const setEnabled = useAtomCommand(environmentCatalog.setEnabled, "environment enable");
  const [reviewed, setReviewed] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    void SecureStore.getItemAsync(storageKey)
      .then((value) => {
        if (active) setReviewed(value !== null);
      })
      .catch(() => {
        if (active) setReviewed(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!catalog.isReady || reviewed !== false || shownThisLaunch) return;
    shownThisLaunch = true;
    const markReviewed = () => {
      setReviewed(true);
      void SecureStore.setItemAsync(storageKey, "1").catch(() => {
        // Remember for this launch even if persistent storage is unavailable.
      });
    };
    const switchedOff = switchedOffSavedEnvironments(catalog);
    // Nothing to ask about now, so a computer switched off later is never asked about.
    if (switchedOff.length === 0) {
      markReviewed();
      return;
    }
    const one = switchedOff.length === 1;
    const names = summarizeEnvironmentLabels(switchedOff);
    Alert.alert(
      one ? `${names} is switched off` : `${switchedOff.length} computers are switched off`,
      `${one ? "" : `${names}. `}An earlier update could switch computers off by mistake. Turn ${one ? "it" : "them"} back on to see ${one ? "its" : "their"} threads again.`,
      [
        { text: "Keep off", style: "cancel", onPress: markReviewed },
        {
          text: "Turn on",
          // The question counts as answered only once every computer switched
          // on, so a failed write asks again on the next launch.
          onPress: async () => {
            const results = await Promise.all(
              switchedOff.map(async (environment) => ({
                environment,
                result: await setEnabled({
                  environmentId: environment.environmentId,
                  enabled: true,
                }),
              })),
            );
            const failed = results.filter(
              ({ result }) => result._tag === "Failure" && !isAtomCommandInterrupted(result),
            );
            if (results.every(({ result }) => result._tag === "Success")) {
              markReviewed();
              return;
            }
            // An interrupted switch stays unanswered but is not an error to show.
            if (failed.length === 0) return;
            Alert.alert(
              `Could not switch on ${summarizeEnvironmentLabels(failed.map(({ environment }) => environment))}`,
              `Switch ${failed.length === 1 ? "it" : "them"} on in Settings → Environments.`,
            );
          },
        },
      ],
      { cancelable: false },
    );
  }, [catalog, reviewed, setEnabled]);
  return null;
}
