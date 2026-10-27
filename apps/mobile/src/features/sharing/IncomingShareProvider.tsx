import * as Dialog from "../../components/ui/Dialog";
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import { PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@t3tools/contracts";
import {
  clearSharedPayloads,
  getResolvedSharedPayloadsAsync,
  getSharedPayloads,
  type ResolvedSharePayload,
  type SharePayload,
} from "expo-sharing";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";

import {
  buildIncomingShareDraft,
  isShareFileUriUnderOwnedRoots,
  type IncomingShareDestination,
  type IncomingShareDraft,
} from "./incoming-share-model";
import { createIncomingSharePayloadReader } from "./incoming-share-native";
import { IncomingShareInbox } from "./incoming-share-inbox";
import { persistComposerAttachmentFile } from "../../lib/composerImages";
import { subscribeAppActive } from "../../lib/appState";
import { coalescedRun } from "../../lib/coalescedRun";
import { rootNavigationRef } from "../../lib/rootNavigation";
import { selectWorkspaceDetail } from "../workspace/workspace-detail-selection";
import { isDraftThreadRoute } from "../threads/thread-route-state";
import {
  EMPTY_INCOMING_SHARE_PRESENTATION_STATE,
  transitionIncomingSharePresentation,
} from "./incoming-share-presentation";
import {
  loadIncomingShareDrafts,
  removeIncomingShareDraft,
  writeIncomingShareDraft,
} from "./incoming-share-storage";

function receiveSharingEnabled(): boolean {
  if (Platform.OS === "android") {
    return true;
  }
  if (Platform.OS !== "ios") {
    return false;
  }
  return Constants.expoConfig?.extra?.iosPersonalTeamBuild !== true;
}

const getIncomingSharePayloads = createIncomingSharePayloadReader({
  platform: Platform.OS,
  readPayloads: getSharedPayloads,
});

async function resolvedPayloadsForFiles(): Promise<ReadonlyArray<ResolvedSharePayload>> {
  try {
    return await getResolvedSharedPayloadsAsync();
  } catch (error) {
    // Raw iOS copied file URLs remain usable; Android's File API can read content URIs when resolution fails.
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

async function readFileSize(uri: string): Promise<number | null> {
  const { File } = await import("expo-file-system");
  return new File(uri).size ?? null;
}

async function removeOwnedFile(uri: string): Promise<void> {
  if (!uri.startsWith("file:")) {
    return;
  }
  try {
    const { File, Paths } = await import("expo-file-system");
    // Delete only app-owned files; iOS open-in-place shares can reference the sender's original.
    const ownedRootUris = [
      Paths.document.uri,
      Paths.cache.uri,
      ...Object.values(Paths.appleSharedContainers ?? {}).map((directory) => directory.uri),
    ];
    if (!isShareFileUriUnderOwnedRoots(uri, ownedRootUris)) {
      return;
    }
    const file = new File(uri);
    if (file.exists) {
      file.delete();
    }
  } catch (error) {
    console.warn("[incoming-share] could not remove temporary shared file", error);
  }
}

async function removeReplayedPayloadFiles(payloads: ReadonlyArray<SharePayload>): Promise<void> {
  const uris = new Set<string>();
  for (const payload of payloads) {
    if (["image", "file", "audio", "video"].includes(payload.shareType)) {
      uris.add(payload.value);
    }
  }
  if (uris.size === 0) {
    return;
  }
  const resolvedPayloads = payloads.some((payload) =>
    ["file", "audio", "video"].includes(payload.shareType),
  )
    ? []
    : await resolvedPayloadsForFiles();
  for (const payload of resolvedPayloads) {
    if (["image", "file", "audio", "video"].includes(payload.shareType) && payload.contentUri) {
      uris.add(payload.contentUri);
    }
  }
  await Promise.all([...uris].map(removeOwnedFile));
}

// Share the queue across remounts so lifecycle notifications cannot ingest one handoff twice.
const incomingShareInbox = new IncomingShareInbox({
  loadDrafts: loadIncomingShareDrafts,
  writeDraft: writeIncomingShareDraft,
  removeDraft: removeIncomingShareDraft,
  getPayloads: getIncomingSharePayloads,
  clearPayloads: clearSharedPayloads,
  buildDraft: async ({ payloads, id, createdAt }) => {
    const cleanupUris = new Set<string>();
    const persistedUris = new Set<string>();
    const hasGenericFilePayload = payloads.some((payload) =>
      ["file", "audio", "video"].includes(payload.shareType),
    );
    const resolvedPayloads =
      !hasGenericFilePayload && payloads.some((payload) => payload.shareType === "image")
        ? await resolvedPayloadsForFiles()
        : [];
    const draft = await buildIncomingShareDraft({
      payloads,
      resolvedPayloads,
      fileReader: {
        readBase64,
        persistFile: async (uri, name) => {
          const persistedUri = await persistComposerAttachmentFile(
            uri,
            name,
            PROVIDER_SEND_TURN_MAX_FILE_BYTES,
          );
          persistedUris.add(persistedUri);
          return persistedUri;
        },
        readSize: readFileSize,
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
      rollback: async () => {
        await Promise.all([...persistedUris].map(removeOwnedFile));
      },
    };
  },
  cleanupReplayedPayloads: removeReplayedPayloadFiles,
  idForPayloads: incomingShareIdForPayloads,
  now: () => new Date().toISOString(),
  onClearError: (error) => {
    console.warn("[incoming-share] could not acknowledge native payload", error);
  },
  onCleanupError: (error) => {
    console.warn("[incoming-share] could not remove temporary shared file", error);
  },
});

interface IncomingShareSnapshot {
  readonly drafts: ReadonlyArray<IncomingShareDraft>;
  readonly isLoading: boolean;
}

let snapshot: IncomingShareSnapshot = { drafts: [], isLoading: true };
const snapshotListeners = new Set<() => void>();
let presentation = EMPTY_INCOMING_SHARE_PRESENTATION_STATE;

function publish(drafts: ReadonlyArray<IncomingShareDraft>) {
  snapshot = { drafts, isLoading: false };
  for (const listener of snapshotListeners) listener();
  presentPendingIncomingShare();
}

function subscribeIncomingShares(onChange: () => void) {
  snapshotListeners.add(onChange);
  return () => {
    snapshotListeners.delete(onChange);
  };
}

function getIncomingShareSnapshot() {
  return snapshot;
}

function reportRefreshFailure(cause: unknown) {
  const error = cause instanceof Error ? cause : new Error("Could not import shared content.");
  Dialog.alert("Could not import shared content", error.message, [
    { text: "Dismiss", style: "cancel" },
    { text: "Retry", onPress: () => void refreshIncomingShares() },
  ]);
}

// A resume while a refresh runs may carry a native handoff that refresh already
// passed, so it queues one more refresh instead of joining the running one.
const refreshIncomingShares = coalescedRun(async () => {
  const enabled = receiveSharingEnabled();
  try {
    publish(await incomingShareInbox.refresh({ ingestNative: enabled }));
  } catch (cause) {
    const persisted = await incomingShareInbox.refresh({ ingestNative: false }).catch(() => null);
    publish(persisted ?? snapshot.drafts);
    reportRefreshFailure(cause);
  }
});

/**
 * Opens the oldest pending share as a new-task draft unless the user already
 * dismissed it. Runs whenever the inbox or the root navigation state changes.
 */
export function presentPendingIncomingShare(): void {
  if (!rootNavigationRef.isReady()) return;
  const state = rootNavigationRef.getRootState();
  if (!state) return;
  const transition = transitionIncomingSharePresentation(presentation, {
    isShareSheetPresented: isDraftThreadRoute(state.routes[state.index]),
    pendingShareId: snapshot.drafts[0]?.id ?? null,
  });
  presentation = transition.state;
  if (!transition.shareIdToPresent) return;
  rootNavigationRef.dispatch(
    selectWorkspaceDetail({
      name: "Thread",
      params: { draft: { incomingShareId: transition.shareIdToPresent } },
    }),
  );
}

/** App-lifetime: loads the inbox and re-ingests native handoffs on every resume. */
export function startIncomingShareInbox(): () => void {
  void refreshIncomingShares();
  return receiveSharingEnabled()
    ? subscribeAppActive(() => void refreshIncomingShares())
    : () => {};
}

async function consumeShare(shareId: string) {
  publish(await incomingShareInbox.consume(shareId));
}

async function reserveShare(shareId: string, destination: IncomingShareDestination) {
  publish(await incomingShareInbox.reserve(shareId, destination));
}

async function releaseShareReservation(
  shareId: string,
  expectedDestination: IncomingShareDestination,
) {
  publish(await incomingShareInbox.releaseReservation(shareId, expectedDestination));
}

export function useIncomingShare() {
  const { drafts, isLoading } = useSyncExternalStore(
    subscribeIncomingShares,
    getIncomingShareSnapshot,
  );
  return {
    pendingShare: drafts[0] ?? null,
    isLoading,
    getShare: (shareId: string) => drafts.find((draft) => draft.id === shareId) ?? null,
    reserveShare,
    releaseShareReservation,
    consumeShare,
  };
}
