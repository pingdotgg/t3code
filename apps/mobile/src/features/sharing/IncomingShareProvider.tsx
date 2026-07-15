import Constants from "expo-constants";
import {
  clearSharedPayloads,
  getResolvedSharedPayloadsAsync,
  getSharedPayloads,
  type ResolvedSharePayload,
  type SharePayload,
} from "expo-sharing";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState, Platform } from "react-native";

import { uuidv4 } from "../../lib/uuid";
import {
  buildIncomingShareDraft,
  hasIncomingShareContent,
  type IncomingShareDraft,
} from "./incoming-share-model";
import {
  loadIncomingShareDrafts,
  removeIncomingShareDraft,
  writeIncomingShareDraft,
} from "./incoming-share-storage";

type IncomingShareContextValue = {
  readonly pendingShare: IncomingShareDraft | null;
  readonly isLoading: boolean;
  readonly error: Error | null;
  readonly consumeShare: (shareId: string) => Promise<void>;
  readonly refresh: () => Promise<void>;
};

const IncomingShareContext = React.createContext<IncomingShareContextValue | null>(null);

function receiveSharingEnabled(): boolean {
  if (Platform.OS === "android") {
    return true;
  }
  if (Platform.OS !== "ios") {
    return false;
  }
  return Constants.expoConfig?.extra?.iosPersonalTeamBuild !== true;
}

function sortAndDedupe(
  drafts: ReadonlyArray<IncomingShareDraft>,
): ReadonlyArray<IncomingShareDraft> {
  return [...new Map(drafts.map((draft) => [draft.id, draft])).values()].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

async function resolvedPayloadsForImages(): Promise<ReadonlyArray<ResolvedSharePayload>> {
  try {
    return await getResolvedSharedPayloadsAsync();
  } catch (error) {
    // iOS already gives the containing app a copied file:// URL, so raw
    // payloads remain usable. Android normally resolves content:// into a
    // private cache file; its modern File API can still read the raw URI when
    // resolution fails.
    console.warn("[incoming-share] could not resolve shared file metadata", error);
    return [];
  }
}

async function readBase64(uri: string): Promise<string> {
  const { File } = await import("expo-file-system");
  return new File(uri).base64();
}

async function removeOwnedFile(uri: string): Promise<void> {
  if (!uri.startsWith("file:")) {
    return;
  }
  try {
    const { File } = await import("expo-file-system");
    const file = new File(uri);
    if (file.exists) {
      file.delete();
    }
  } catch (error) {
    console.warn("[incoming-share] could not remove temporary shared file", error);
  }
}

export function IncomingShareProvider(props: React.PropsWithChildren) {
  const enabled = receiveSharingEnabled();
  const [drafts, setDrafts] = useState<ReadonlyArray<IncomingShareDraft>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) {
      return;
    }
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current;
    }

    const operation = (async () => {
      let payloads: SharePayload[];
      try {
        payloads = getSharedPayloads();
      } catch (cause) {
        setError(cause instanceof Error ? cause : new Error("Could not read shared content."));
        return;
      }
      if (payloads.length === 0) {
        return;
      }

      try {
        const resolvedPayloads = payloads.some((payload) => payload.shareType === "image")
          ? await resolvedPayloadsForImages()
          : [];
        const draft = await buildIncomingShareDraft({
          payloads,
          resolvedPayloads,
          fileReader: { readBase64, removeOwnedFile },
          id: uuidv4(),
          createdAt: new Date().toISOString(),
        });
        if (!hasIncomingShareContent(draft)) {
          throw new Error(
            draft.warnings[0] ?? "The shared content is not supported by the composer.",
          );
        }
        // Persist before acknowledging the native handoff. If the process is
        // killed while the user chooses a project, the next launch recovers it.
        await writeIncomingShareDraft(draft);
        setDrafts((current) => sortAndDedupe([draft, ...current]));
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause : new Error("Could not import shared content."));
      } finally {
        // A failed/unsupported payload must not reopen the share flow forever.
        try {
          clearSharedPayloads();
        } catch (cause) {
          console.warn("[incoming-share] could not acknowledge native payload", cause);
        }
      }
    })().finally(() => {
      refreshPromiseRef.current = null;
    });

    refreshPromiseRef.current = operation;
    return operation;
  }, [enabled]);

  useEffect(() => {
    let cancelled = false;
    void loadIncomingShareDrafts()
      .then((persisted) => {
        if (!cancelled) {
          setDrafts((current) => sortAndDedupe([...current, ...persisted]));
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause : new Error("Could not load shared drafts."));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
          void refresh();
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void refresh();
      }
    });
    return () => subscription.remove();
  }, [enabled, refresh]);

  useEffect(() => {
    if (!error) {
      return;
    }
    Alert.alert("Could not import shared content", error.message, [
      { text: "OK", onPress: () => setError(null) },
    ]);
  }, [error]);

  const consumeShare = useCallback(async (shareId: string) => {
    await removeIncomingShareDraft(shareId);
    setDrafts((current) => current.filter((draft) => draft.id !== shareId));
  }, []);

  const value = useMemo<IncomingShareContextValue>(
    () => ({
      pendingShare: drafts[0] ?? null,
      isLoading,
      error,
      consumeShare,
      refresh,
    }),
    [consumeShare, drafts, error, isLoading, refresh],
  );

  return (
    <IncomingShareContext.Provider value={value}>{props.children}</IncomingShareContext.Provider>
  );
}

export function useIncomingShare(): IncomingShareContextValue {
  const value = React.use(IncomingShareContext);
  if (value === null) {
    throw new Error("useIncomingShare must be used within IncomingShareProvider.");
  }
  return value;
}
