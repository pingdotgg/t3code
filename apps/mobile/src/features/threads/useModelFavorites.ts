import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import type { ModelOption } from "../../lib/modelOptions";
import type { Preferences } from "../../persistence/mobile-preferences";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/** Persists model favorites on this device without inventing a server setting. */
export function useModelFavorites(environmentId: EnvironmentId | null) {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const favoritesReady = AsyncResult.isSuccess(preferencesResult);
  const storedKeys = favoritesReady ? (preferencesResult.value.favoriteModelKeys ?? []) : [];
  const environmentPrefix = environmentId === null ? null : `${environmentId}:`;

  const favoriteModelKeys = useMemo(() => {
    if (environmentPrefix === null) return new Set<string>();
    return new Set(
      storedKeys.flatMap((key) =>
        key.startsWith(environmentPrefix) ? [key.slice(environmentPrefix.length)] : [],
      ),
    );
  }, [environmentPrefix, storedKeys]);

  const toggleFavorite = useCallback(
    (option: ModelOption) => {
      if (environmentPrefix === null || !favoritesReady) return;
      const scopedKey = `${environmentPrefix}${option.key}`;
      savePreferences((current: Preferences) => {
        const currentKeys = current.favoriteModelKeys ?? [];
        return {
          favoriteModelKeys: currentKeys.includes(scopedKey)
            ? currentKeys.filter((key) => key !== scopedKey)
            : [...currentKeys, scopedKey],
        };
      });
    },
    [environmentPrefix, favoritesReady, savePreferences],
  );

  return { favoriteModelKeys, favoritesReady, toggleFavorite };
}
