import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import {
  clearSharedPayloads,
  getResolvedSharedPayloadsAsync,
  getSharedPayloads,
  type ResolvedSharePayload,
  type SharePayload,
} from "expo-sharing";
import React, { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Alert, AppState, Platform } from "react-native";

import {
  buildIncomingShareDraft,
  type IncomingShareDestination,
  type IncomingShareDraft,
} from "./incoming-share-model";
import { IncomingShareInbox } from "./incoming-share-inbox";
import {
  loadIncomingShareDrafts,
  removeIncomingShareDraft,
  writeIncomingShareDraft,
} from "./incoming-share-storage";

type IncomingShareContextValue = {
  readonly pendingShare: IncomingShareDraft | null;
  readonly isLoading: boolean;
  readonly error: Error | null;
  readonly getShare: (shareId: string) => IncomingShareDraft | null;
  readonly reserveShare: (shareId: string, destination: IncomingShareDestination) => Promise<void>;
  readonly releaseShareReservation: (
    shareId: string,
    expectedDestination: IncomingShareDestination,
  ) => Promise<void>;
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

async function incomingShareIdForPayloads(payloads: ReadonlyArray<SharePayload>): Promise<string> {
  const fingerprint = JSON.stringify(
    payloads.map((payload) => ({
      shareType: payload.shareType,
      mimeType: payload.mimeType ?? null,
      value: payload.value,
    })),
  );
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, fingerprint);
  return `share-${digest}`;
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

async function removeReplayedImagePayloadFiles(
  payloads: ReadonlyArray<SharePayload>,
): Promise<void> {
  const uris = new Set<string>();
  for (const payload of payloads) {
    if (payload.shareType === "image") {
      uris.add(payload.value);
    }
  }
  if (uris.size === 0) {
    return;
  }
  const resolvedPayloads = await resolvedPayloadsForImages();
  for (const payload of resolvedPayloads) {
    if (payload.shareType === "image" && payload.contentUri) {
      uris.add(payload.contentUri);
    }
  }
  await Promise.all([...uris].map(removeOwnedFile));
}

// Keep one operation queue across provider remounts (including development
// Strict Mode remounts) so two app lifecycle notifications cannot ingest the
// same native handoff independently.
const incomingShareInbox = new IncomingShareInbox({
  loadDrafts: loadIncomingShareDrafts,
  writeDraft: writeIncomingShareDraft,
  removeDraft: removeIncomingShareDraft,
  getPayloads: getSharedPayloads,
  clearPayloads: clearSharedPayloads,
  buildDraft: async ({ payloads, id, createdAt }) => {
    const cleanupUris = new Set<string>();
    const resolvedPayloads = payloads.some((payload) => payload.shareType === "image")
      ? await resolvedPayloadsForImages()
      : [];
    const draft = await buildIncomingShareDraft({
      payloads,
      resolvedPayloads,
      fileReader: {
        readBase64,
        removeOwnedFile: (uri) => {
          cleanupUris.add(uri);
        },
      },
      id,
      createdAt,
    });
    return {
      draft,
      cleanup: async () => {
        await Promise.all([...cleanupUris].map(removeOwnedFile));
      },
    };
  },
  cleanupReplayedPayloads: removeReplayedImagePayloadFiles,
  idForPayloads: incomingShareIdForPayloads,
  now: () => new Date().toISOString(),
  onClearError: (error) => {
    console.warn("[incoming-share] could not acknowledge native payload", error);
  },
  onCleanupError: (error) => {
    console.warn("[incoming-share] could not remove temporary shared file", error);
  },
});

export function IncomingShareProvider(props: React.PropsWithChildren) {
  const enabled = receiveSharingEnabled();
  const [drafts, setDrafts] = useState<ReadonlyArray<IncomingShareDraft>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current;
    }

    const operation = (async () => {
      try {
        const snapshot = await incomingShareInbox.refresh({ ingestNative: enabled });
        if (mountedRef.current) {
          setDrafts(snapshot);
          setError(null);
        }
      } catch (cause) {
        const persisted = await incomingShareInbox
          .refresh({ ingestNative: false })
          .catch(() => null);
        if (mountedRef.current) {
          if (persisted) {
            setDrafts(persisted);
          }
          setError(cause instanceof Error ? cause : new Error("Could not import shared content."));
        }
      }
    })().finally(() => {
      refreshPromiseRef.current = null;
    });

    refreshPromiseRef.current = operation;
    return operation;
  }, [enabled]);

  useEffect(() => {
    void refresh().finally(() => {
      if (mountedRef.current) {
        setIsLoading(false);
      }
    });
  }, [refresh]);

  const refreshOnAppActive = useEffectEvent(() => {
    void refresh();
  });

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        refreshOnAppActive();
      }
    });
    return () => subscription.remove();
  }, [enabled]);

  useEffect(() => {
    if (!error) {
      return;
    }
    Alert.alert("Could not import shared content", error.message, [
      { text: "Dismiss", style: "cancel", onPress: () => setError(null) },
      {
        text: "Retry",
        onPress: () => {
          setError(null);
          void refresh();
        },
      },
    ]);
  }, [error, refresh]);

  const consumeShare = useCallback(async (shareId: string) => {
    const snapshot = await incomingShareInbox.consume(shareId);
    if (mountedRef.current) {
      setDrafts(snapshot);
    }
  }, []);
  const reserveShare = useCallback(
    async (shareId: string, destination: IncomingShareDestination) => {
      const snapshot = await incomingShareInbox.reserve(shareId, destination);
      if (mountedRef.current) {
        setDrafts(snapshot);
      }
    },
    [],
  );
  const releaseShareReservation = useCallback(
    async (shareId: string, expectedDestination: IncomingShareDestination) => {
      const snapshot = await incomingShareInbox.releaseReservation(shareId, expectedDestination);
      if (mountedRef.current) {
        setDrafts(snapshot);
      }
    },
    [],
  );
  const getShare = useCallback(
    (shareId: string) => drafts.find((draft) => draft.id === shareId) ?? null,
    [drafts],
  );

  const value = useMemo<IncomingShareContextValue>(
    () => ({
      pendingShare: drafts[0] ?? null,
      isLoading,
      error,
      getShare,
      releaseShareReservation,
      reserveShare,
      consumeShare,
      refresh,
    }),
    [
      consumeShare,
      drafts,
      error,
      getShare,
      isLoading,
      refresh,
      releaseShareReservation,
      reserveShare,
    ],
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
