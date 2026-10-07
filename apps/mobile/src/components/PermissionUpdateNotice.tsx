import { useAtomValue } from "@effect/atom-react";
import { sessionHasLegacyPermissions } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import * as SecureStore from "expo-secure-store";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";

import { useEnvironments } from "../state/environments";
import { environmentSession } from "../state/session";

const storageKey = "t3code.permission-update.v1";
const dismissedThisLaunch = new Set<string>();
const shownThisLaunch = new Set<string>();

export function PermissionUpdateNotice() {
  const { environments } = useEnvironments();
  const [dismissed, setDismissed] = useState<ReadonlySet<string> | null>(null);
  const showing = useRef(false);
  const affected = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          environments.filter(({ environmentId }) => {
            const session = get(environmentSession.sessionStateAtom(environmentId));
            return (
              session._tag === "Success" &&
              !session.waiting &&
              sessionHasLegacyPermissions(session.value)
            );
          }),
        ),
      [environments],
    ),
  );

  useEffect(() => {
    let active = true;
    void SecureStore.getItemAsync(storageKey)
      .then((raw) => {
        const value: unknown = raw === null ? [] : JSON.parse(raw);
        if (active)
          setDismissed(
            new Set(
              Array.isArray(value)
                ? value.filter((id): id is string => typeof id === "string")
                : [],
            ),
          );
      })
      .catch(() => {
        if (active) setDismissed(new Set());
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (dismissed === null || showing.current) return;
    const environment = affected.find(
      ({ environmentId }) => !dismissed.has(environmentId) && !shownThisLaunch.has(environmentId),
    );
    if (!environment) return;
    showing.current = true;
    shownThisLaunch.add(environment.environmentId);
    const dismiss = () => {
      dismissedThisLaunch.add(environment.environmentId);
      const next = new Set([...dismissed, ...dismissedThisLaunch]);
      // Keep notices serial when several environments have old grants.
      showing.current = false;
      setDismissed(next);
      void SecureStore.setItemAsync(storageKey, JSON.stringify([...next])).catch(() => {
        // Remember for this launch even if persistent storage is unavailable.
      });
    };
    Alert.alert(
      `Permissions have changed for ${environment.label}`,
      "This connection still uses the old permissions, so some actions may no longer be available. Pair again using a new link with the permissions you need.",
      [{ text: "Got it", onPress: dismiss }],
      { cancelable: false },
    );
  }, [affected, dismissed]);
  return null;
}
