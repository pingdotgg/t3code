import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type PreviewReviewSnapshot,
  type PreviewSessionSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  ScrollView,
  TextInput as NativeTextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { EmptyState } from "../../components/EmptyState";
import { LoadingStrip } from "../../components/LoadingStrip";
import { relativeTime } from "../../lib/time";
import { uuidv4 } from "../../lib/uuid";
import { scopedThreadKey } from "../../lib/scopedEntities";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import { mergeComposerDraftContent } from "../../state/use-composer-drafts";
import { useSavedRemoteConnection } from "../../state/use-remote-environment-registry";
import { useEnvironmentQuery } from "../../state/query";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { ImageMarkupModal, type ImageMarkupSemanticElement } from "../annotations/ImageMarkupModal";
import {
  createPreviewSnapshotMarkupSeed,
  normalizedRectForSemanticElement,
  previewSnapshotIsStale,
  type PreviewSnapshotMarkupSeed,
} from "./previewReviewModel";
import {
  MobileLivePreview,
  type MobileLivePreviewHandle,
  type MobileLivePreviewNavigation,
} from "./MobileLivePreview";
import {
  mobilePreviewGatewayRequestKey,
  mobilePreviewGatewayTargetMatches,
  resolveMobilePreviewGatewayUri,
  type MobilePreviewGatewayTarget,
} from "./mobilePreviewGatewayModel";
import { previewCaptureErrorMessage } from "./previewPaneModel";
import { resolveMobilePreviewLiveTarget } from "./previewLiveTarget";
import {
  mergePreviewSessionSnapshots,
  previewCaptureCanCommit,
  previewEventRequiresSessionRefresh,
  previewLiveUrlForSelection,
  upsertPreviewSessionSnapshot,
} from "./previewPaneModel";

function sessionTitle(session: PreviewSessionSnapshot): string {
  if (session.navStatus._tag === "Idle") return "New tab";
  const title = session.navStatus.title.trim();
  if (title.length > 0) return title;
  try {
    return new URL(session.navStatus.url).host || "Browser";
  } catch {
    return "Browser";
  }
}

function formatCaptureError(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  return previewCaptureErrorMessage(squashAtomCommandFailure(result));
}

function formatCommandError(
  result: Parameters<typeof squashAtomCommandFailure>[0],
  fallback: string,
): string {
  const error = squashAtomCommandFailure(result);
  const message =
    error instanceof Error ? error.message.trim() : typeof error === "string" ? error.trim() : "";
  return message || fallback;
}

function PreviewTabPicker(props: {
  readonly creating: boolean;
  readonly sessions: ReadonlyArray<PreviewSessionSnapshot>;
  readonly selectedTabId: string | null;
  readonly onCreate: () => void;
  readonly onSelect: (tabId: string) => void;
}) {
  return (
    <ScrollView
      horizontal
      className="min-w-0 flex-1"
      contentContainerClassName="items-center gap-1.5 pr-2"
      showsHorizontalScrollIndicator={false}
    >
      {props.sessions.map((session) => {
        const selected = session.tabId === props.selectedTabId;
        return (
          <Pressable
            key={session.tabId}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            className={`h-9 max-w-52 justify-center rounded-full border px-3 ${
              selected ? "border-primary bg-primary/10" : "border-border bg-card"
            }`}
            onPress={() => props.onSelect(session.tabId)}
          >
            <Text
              numberOfLines={1}
              className={
                selected
                  ? "text-xs font-t3-bold text-primary"
                  : "text-xs font-t3-medium text-foreground"
              }
            >
              {sessionTitle(session)}
            </Text>
          </Pressable>
        );
      })}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New browser tab"
        disabled={props.creating}
        className="size-9 items-center justify-center rounded-full bg-subtle active:opacity-70 disabled:opacity-45"
        onPress={props.onCreate}
      >
        {props.creating ? (
          <ActivityIndicator size="small" />
        ) : (
          <SymbolView name="plus" size={16} type="monochrome" />
        )}
      </Pressable>
    </ScrollView>
  );
}

function SnapshotImage(props: {
  readonly snapshot: PreviewReviewSnapshot;
  readonly capturing: boolean;
}) {
  return (
    <View className="relative min-h-0 flex-1 bg-black">
      {props.capturing ? <LoadingStrip /> : null}
      <Image
        accessibilityLabel={`Frozen preview of ${props.snapshot.title || props.snapshot.url}`}
        source={{
          uri: `data:${props.snapshot.screenshot.mimeType};base64,${props.snapshot.screenshot.data}`,
        }}
        resizeMode="contain"
        className="flex-1"
      />
    </View>
  );
}

export function ThreadPreviewPane(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly presentation: "inspector" | "screen";
  readonly fullscreen?: boolean;
  readonly onFullscreenChange?: (fullscreen: boolean) => void;
  readonly headerInset?: number;
  readonly onAttachmentAdded?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const savedConnection = useSavedRemoteConnection(props.environmentId);
  const listQuery = useEnvironmentQuery(
    previewEnvironment.list({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );
  const eventsQuery = useEnvironmentQuery(
    previewEnvironment.events({
      environmentId: props.environmentId,
      input: {},
    }),
  );
  const openTab = useAtomCommand(previewEnvironment.open, {
    label: "open browser tab",
    reportDefect: false,
    reportFailure: false,
  });
  const navigateTab = useAtomCommand(previewEnvironment.navigate, {
    label: "navigate browser tab",
    reportDefect: false,
    reportFailure: false,
  });
  const reviewSnapshot = useAtomCommand(previewEnvironment.reviewSnapshot, {
    label: "preview review snapshot",
    reportDefect: false,
    reportFailure: false,
  });
  const openLiveGateway = useAtomCommand(previewEnvironment.openLiveGateway, {
    label: "open live preview gateway",
    reportDefect: false,
    reportFailure: false,
  });
  const [selectedTabId, setSelectedTabId] = useState<string | null>(null);
  const [optimisticSessions, setOptimisticSessions] = useState<
    ReadonlyArray<PreviewSessionSnapshot>
  >([]);
  const [creatingTab, setCreatingTab] = useState(false);
  const [navigatingTab, setNavigatingTab] = useState(false);
  const [addressDraft, setAddressDraft] = useState("");
  const [addressFocused, setAddressFocused] = useState(false);
  const [focusAddressTabId, setFocusAddressTabId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<PreviewReviewSnapshot | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [capturingLocalMarkup, setCapturingLocalMarkup] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [snapshotChanged, setSnapshotChanged] = useState(false);
  const [showingDesktopSnapshot, setShowingDesktopSnapshot] = useState(false);
  const [markupVisible, setMarkupVisible] = useState(false);
  const [markupModalSeed, setMarkupModalSeed] = useState<PreviewSnapshotMarkupSeed | null>(null);
  const [markupSeedGeneration, setMarkupSeedGeneration] = useState(0);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [liveReady, setLiveReady] = useState(false);
  const [liveNavigation, setLiveNavigation] = useState<MobileLivePreviewNavigation | null>(null);
  const [gatewayOpening, setGatewayOpening] = useState(false);
  const [gatewayError, setGatewayError] = useState<string | null>(null);
  const [gatewayTarget, setGatewayTarget] = useState<MobilePreviewGatewayTarget | null>(null);
  const livePreviewRef = useRef<MobileLivePreviewHandle>(null);
  const addressInputRef = useRef<NativeTextInput>(null);
  const selectedTabIdRef = useRef<string | null>(selectedTabId);
  const createTabRequestIdRef = useRef(0);
  const navigateTabRequestIdRef = useRef(0);
  const captureRequestIdRef = useRef(0);
  const gatewayRequestIdRef = useRef(0);
  const requestedGatewayRef = useRef<string | null>(null);
  const refreshedEventRef = useRef<string | null>(null);
  selectedTabIdRef.current = selectedTabId;
  const serverSessions = useMemo(() => listQuery.data?.sessions ?? [], [listQuery.data?.sessions]);
  const sessions = useMemo(
    () => mergePreviewSessionSnapshots(serverSessions, optimisticSessions),
    [optimisticSessions, serverSessions],
  );
  const selectedSession =
    sessions.find((session) => session.tabId === selectedTabId) ?? sessions.at(-1) ?? null;

  useEffect(
    () => () => {
      createTabRequestIdRef.current += 1;
      navigateTabRequestIdRef.current += 1;
      captureRequestIdRef.current += 1;
      gatewayRequestIdRef.current += 1;
    },
    [],
  );
  useEffect(() => {
    createTabRequestIdRef.current += 1;
    navigateTabRequestIdRef.current += 1;
    captureRequestIdRef.current += 1;
    gatewayRequestIdRef.current += 1;
    requestedGatewayRef.current = null;
    setSnapshot(null);
    setShowingDesktopSnapshot(false);
    setMarkupVisible(false);
    setMarkupModalSeed(null);
    setCapturing(false);
    setCapturingLocalMarkup(false);
    setGatewayTarget(null);
    setGatewayError(null);
    setGatewayOpening(false);
    setLiveNavigation(null);
    setLiveReady(false);
    setOptimisticSessions([]);
    setCreatingTab(false);
    setNavigatingTab(false);
    setAddressDraft("");
    setAddressFocused(false);
    setFocusAddressTabId(null);
  }, [props.environmentId, props.threadId]);

  useEffect(() => {
    setOptimisticSessions((current) => {
      const pending = current.filter((optimistic) => {
        const server = serverSessions.find((session) => session.tabId === optimistic.tabId);
        return !server || server.updatedAt < optimistic.updatedAt;
      });
      return pending.length === current.length ? current : pending;
    });
  }, [serverSessions]);

  useEffect(() => {
    if (sessions.length === 0) {
      if (!listQuery.isPending) {
        captureRequestIdRef.current += 1;
        setSelectedTabId(null);
        setSnapshot(null);
        setShowingDesktopSnapshot(false);
        setCapturing(false);
        setGatewayTarget(null);
        setGatewayOpening(false);
      }
      return;
    }
    if (!selectedTabId || !sessions.some((session) => session.tabId === selectedTabId)) {
      setSelectedTabId(sessions.at(-1)!.tabId);
    }
  }, [listQuery.isPending, selectedTabId, sessions]);

  useEffect(() => {
    if (focusAddressTabId === null || focusAddressTabId !== selectedTabId) return;
    const requestedTabId = focusAddressTabId;
    const frame = requestAnimationFrame(() => {
      addressInputRef.current?.focus();
      setFocusAddressTabId((current) => (current === requestedTabId ? null : current));
    });
    return () => cancelAnimationFrame(frame);
  }, [focusAddressTabId, selectedTabId]);

  const selectBrowserTab = useCallback((tabId: string) => {
    captureRequestIdRef.current += 1;
    selectedTabIdRef.current = tabId;
    addressInputRef.current?.blur();
    setAddressFocused(false);
    setFocusAddressTabId(null);
    setSelectedTabId(tabId);
    setSnapshot(null);
    setSnapshotChanged(false);
    setShowingDesktopSnapshot(false);
    setCaptureError(null);
    setAttachmentNotice(null);
    gatewayRequestIdRef.current += 1;
    requestedGatewayRef.current = null;
    setGatewayTarget(null);
    setGatewayError(null);
    setGatewayOpening(false);
    setLiveNavigation(null);
    setLiveReady(false);
  }, []);

  const captureSnapshot = useCallback(
    async (tabId: string) => {
      const requestId = captureRequestIdRef.current + 1;
      captureRequestIdRef.current = requestId;
      setCapturing(true);
      setShowingDesktopSnapshot(true);
      setCaptureError(null);
      setAttachmentNotice(null);
      const result = await reviewSnapshot({
        environmentId: props.environmentId,
        input: {
          version: 1,
          threadId: props.threadId,
          tabId,
        },
      });
      const requestIsCurrent =
        captureRequestIdRef.current === requestId && selectedTabIdRef.current === tabId;
      if (!requestIsCurrent) return;
      if (result._tag === "Failure") {
        setCaptureError(formatCaptureError(result));
        setCapturing(false);
        return;
      }
      if (
        !previewCaptureCanCommit({
          activeRequestId: captureRequestIdRef.current,
          requestId,
          selectedTabId: selectedTabIdRef.current,
          requestedTabId: tabId,
          threadId: props.threadId,
          snapshot: result.value,
        })
      ) {
        setCaptureError("The desktop browser returned a snapshot for a different tab.");
        setCapturing(false);
        return;
      }
      setSnapshot(result.value);
      setSnapshotChanged(false);
      setCapturing(false);
    },
    [props.environmentId, props.threadId, reviewSnapshot],
  );

  const latestEvent = eventsQuery.data;
  useEffect(() => {
    if (
      !latestEvent ||
      !previewEventRequiresSessionRefresh({
        event: latestEvent,
        threadId: props.threadId,
        serverEpoch: listQuery.data?.serverEpoch ?? null,
        revision: listQuery.data?.revision ?? null,
      })
    ) {
      return;
    }
    const eventKey = `${latestEvent.serverEpoch}:${latestEvent.revision}`;
    if (refreshedEventRef.current === eventKey) return;
    refreshedEventRef.current = eventKey;
    listQuery.refresh();
  }, [
    latestEvent,
    listQuery.data?.revision,
    listQuery.data?.serverEpoch,
    listQuery.refresh,
    props.threadId,
  ]);
  useEffect(() => {
    if (snapshot && latestEvent && previewSnapshotIsStale(snapshot, latestEvent)) {
      setSnapshotChanged(true);
    }
  }, [latestEvent, snapshot]);

  const livePreviewUrl = useMemo(
    () =>
      previewLiveUrlForSelection({
        selectedTabId,
        selectedSession,
        snapshot,
        latestEvent,
        threadId: props.threadId,
        serverEpoch: listQuery.data?.serverEpoch ?? null,
        revision: listQuery.data?.revision ?? null,
      }),
    [
      latestEvent,
      listQuery.data?.revision,
      listQuery.data?.serverEpoch,
      props.threadId,
      selectedSession,
      selectedTabId,
      snapshot,
    ],
  );
  const liveTarget = useMemo(
    () =>
      livePreviewUrl
        ? resolveMobilePreviewLiveTarget({
            previewUrl: livePreviewUrl,
            environmentHttpBaseUrl: savedConnection?.httpBaseUrl ?? null,
            environmentRelayManaged: savedConnection?.relayManaged ?? false,
            platform: Platform.OS === "android" ? "android" : "ios",
          })
        : null,
    [livePreviewUrl, savedConnection?.httpBaseUrl, savedConnection?.relayManaged],
  );
  const gatewayEligible =
    Platform.OS === "ios" &&
    selectedTabId !== null &&
    livePreviewUrl !== null &&
    liveTarget?.kind === "unavailable" &&
    liveTarget.reason === "gateway-required";
  const requestLiveGateway = useCallback(
    async (tabId: string, sourceUrl: string) => {
      const httpBaseUrl = savedConnection?.httpBaseUrl;
      if (!httpBaseUrl) {
        setGatewayError("The environment address is unavailable.");
        setGatewayOpening(false);
        return;
      }
      const requestId = gatewayRequestIdRef.current + 1;
      const serverEpoch = listQuery.data?.serverEpoch ?? null;
      gatewayRequestIdRef.current = requestId;
      setGatewayOpening(true);
      setGatewayError(null);
      setGatewayTarget(null);
      const result = await openLiveGateway({
        environmentId: props.environmentId,
        input: {
          version: 1,
          threadId: props.threadId,
          tabId,
        },
      });
      if (gatewayRequestIdRef.current !== requestId || selectedTabIdRef.current !== tabId) {
        return;
      }
      setGatewayOpening(false);
      if (result._tag === "Failure") {
        setGatewayError(
          formatCommandError(result, "Browser could not be opened through the preview gateway."),
        );
        return;
      }
      try {
        const uri = resolveMobilePreviewGatewayUri({
          environmentHttpBaseUrl: httpBaseUrl,
          relativeUrl: result.value.relativeUrl,
        });
        setGatewayTarget({
          environmentHttpBaseUrl: httpBaseUrl,
          expiresAt: result.value.expiresAt,
          serverEpoch,
          sourceUrl,
          tabId,
          uri,
        });
      } catch (cause) {
        setGatewayError(
          cause instanceof Error
            ? cause.message
            : "The browser gateway returned an invalid bootstrap address.",
        );
      }
    },
    [
      openLiveGateway,
      listQuery.data?.serverEpoch,
      props.environmentId,
      props.threadId,
      savedConnection?.httpBaseUrl,
    ],
  );
  const issueLiveGatewayRequest = useCallback(
    (tabId: string, sourceUrl: string) => {
      requestedGatewayRef.current = mobilePreviewGatewayRequestKey({
        serverEpoch: listQuery.data?.serverEpoch ?? null,
        sourceUrl,
        tabId,
      });
      void requestLiveGateway(tabId, sourceUrl);
    },
    [listQuery.data?.serverEpoch, requestLiveGateway],
  );
  useEffect(() => {
    if (!gatewayEligible || !selectedTabId || !livePreviewUrl) {
      requestedGatewayRef.current = null;
      if (liveTarget?.kind === "available") {
        gatewayRequestIdRef.current += 1;
        setGatewayOpening(false);
        setGatewayError(null);
        setGatewayTarget(null);
      }
      return;
    }
    if (
      mobilePreviewGatewayTargetMatches({
        target: gatewayTarget,
        tabId: selectedTabId,
        environmentHttpBaseUrl: savedConnection?.httpBaseUrl ?? "",
        serverEpoch: listQuery.data?.serverEpoch ?? null,
        sourceUrl: livePreviewUrl,
      })
    ) {
      return;
    }
    const requestKey = mobilePreviewGatewayRequestKey({
      serverEpoch: listQuery.data?.serverEpoch ?? null,
      sourceUrl: livePreviewUrl,
      tabId: selectedTabId,
    });
    if (requestedGatewayRef.current === requestKey) return;
    issueLiveGatewayRequest(selectedTabId, livePreviewUrl);
  }, [
    gatewayEligible,
    gatewayTarget,
    listQuery.data?.serverEpoch,
    livePreviewUrl,
    liveTarget,
    issueLiveGatewayRequest,
    savedConnection?.httpBaseUrl,
    selectedTabId,
  ]);
  const effectiveLiveTarget = useMemo(() => {
    if (liveTarget?.kind === "available") {
      return {
        isolatedSession: false,
        uri: liveTarget.uri,
      };
    }
    if (
      gatewayEligible &&
      gatewayTarget &&
      selectedTabId &&
      livePreviewUrl &&
      mobilePreviewGatewayTargetMatches({
        target: gatewayTarget,
        tabId: selectedTabId,
        environmentHttpBaseUrl: savedConnection?.httpBaseUrl ?? "",
        serverEpoch: listQuery.data?.serverEpoch ?? null,
        sourceUrl: livePreviewUrl,
      })
    ) {
      return {
        isolatedSession: true,
        uri: gatewayTarget.uri,
      };
    }
    return null;
  }, [
    gatewayEligible,
    gatewayTarget,
    listQuery.data?.serverEpoch,
    livePreviewUrl,
    liveTarget,
    savedConnection?.httpBaseUrl,
    selectedTabId,
  ]);
  const reopenLiveGateway = useCallback(() => {
    if (!gatewayEligible || !selectedTabId || !livePreviewUrl) return;
    gatewayRequestIdRef.current += 1;
    requestedGatewayRef.current = null;
    setGatewayTarget(null);
    setGatewayError(null);
    setGatewayOpening(true);
    setLiveReady(false);
    issueLiveGatewayRequest(selectedTabId, livePreviewUrl);
  }, [gatewayEligible, issueLiveGatewayRequest, livePreviewUrl, selectedTabId]);
  const desktopMarkupSeed = useMemo(() => {
    if (!snapshot) return { value: null, error: null };
    try {
      return {
        value: createPreviewSnapshotMarkupSeed({
          snapshot,
          attachmentId: uuidv4(),
          annotationId: uuidv4(),
        }),
        error: null,
      };
    } catch (cause) {
      return {
        value: null,
        error: cause instanceof Error ? cause.message : "The snapshot cannot be attached.",
      };
    }
  }, [markupSeedGeneration, snapshot]);
  const markupSemanticElements = useMemo<ReadonlyArray<ImageMarkupSemanticElement>>(() => {
    const seed = markupModalSeed;
    const annotation = seed?.attachment.markup?.annotation;
    if (!seed || !annotation) return [];
    return seed.semanticElements.flatMap((target) => {
      const rect = normalizedRectForSemanticElement(target, annotation);
      return rect ? [{ target, rect }] : [];
    });
  }, [markupModalSeed]);

  const handleAnnotate = useCallback(async () => {
    setCaptureError(null);
    setAttachmentNotice(null);
    if (showingDesktopSnapshot) {
      if (!desktopMarkupSeed.value) {
        setCaptureError(desktopMarkupSeed.error ?? "The snapshot is not ready for markup.");
        return;
      }
      setMarkupModalSeed(desktopMarkupSeed.value);
      setMarkupVisible(true);
      return;
    }
    const livePreview = livePreviewRef.current;
    if (!livePreview) {
      setCaptureError("Wait for Browser to finish loading.");
      return;
    }
    const requestId = captureRequestIdRef.current + 1;
    const tabId = selectedTabIdRef.current;
    captureRequestIdRef.current = requestId;
    setCapturingLocalMarkup(true);
    try {
      const seed = await livePreview.captureForMarkup();
      if (captureRequestIdRef.current !== requestId || selectedTabIdRef.current !== tabId) return;
      setMarkupModalSeed(seed);
      setMarkupVisible(true);
    } catch (cause) {
      if (captureRequestIdRef.current !== requestId || selectedTabIdRef.current !== tabId) return;
      setCaptureError(cause instanceof Error ? cause.message : "Browser could not be captured.");
    } finally {
      if (captureRequestIdRef.current === requestId && selectedTabIdRef.current === tabId) {
        setCapturingLocalMarkup(false);
      }
    }
  }, [desktopMarkupSeed.error, desktopMarkupSeed.value, showingDesktopSnapshot]);

  const handleMarkupDone = useCallback(
    async (attachment: DraftComposerImageAttachment) => {
      try {
        const result = await mergeComposerDraftContent(
          scopedThreadKey(props.environmentId, props.threadId),
          { text: "", attachments: [attachment] },
        );
        if (result.skippedAttachmentCount > 0) {
          setCaptureError("This message already has the maximum of 8 image attachments.");
          return;
        }
        setMarkupVisible(false);
        setMarkupModalSeed(null);
        setMarkupSeedGeneration((current) => current + 1);
        setCaptureError(null);
        setAttachmentNotice("Annotated snapshot added to your message.");
        props.onAttachmentAdded?.();
      } catch (cause) {
        setCaptureError(
          cause instanceof Error
            ? cause.message
            : "The annotated snapshot could not be saved to your message.",
        );
      }
    },
    [props.environmentId, props.onAttachmentAdded, props.threadId],
  );

  const topInset =
    props.presentation === "inspector"
      ? Math.max(insets.top, props.headerInset ?? 0)
      : (props.headerInset ?? 0);
  const showDesktopSnapshot = useCallback(() => {
    if (!selectedTabId) return;
    setCaptureError(null);
    setAttachmentNotice(null);
    if (snapshot?.tabId === selectedTabId) {
      setShowingDesktopSnapshot(true);
      return;
    }
    void captureSnapshot(selectedTabId);
  }, [captureSnapshot, selectedTabId, snapshot?.tabId]);
  const handleCreateTab = useCallback(async () => {
    if (creatingTab) return;
    const requestId = createTabRequestIdRef.current + 1;
    createTabRequestIdRef.current = requestId;
    setCreatingTab(true);
    setCaptureError(null);
    setAttachmentNotice(null);
    const result = await openTab({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    });
    if (createTabRequestIdRef.current !== requestId) return;
    setCreatingTab(false);
    if (result._tag === "Failure") {
      setCaptureError(formatCommandError(result, "A new browser tab could not be created."));
      return;
    }
    setOptimisticSessions((current) => upsertPreviewSessionSnapshot(current, result.value));
    selectBrowserTab(result.value.tabId);
    setAddressDraft("");
    setFocusAddressTabId(result.value.tabId);
    listQuery.refresh();
  }, [
    creatingTab,
    listQuery.refresh,
    openTab,
    props.environmentId,
    props.threadId,
    selectBrowserTab,
  ]);
  const handleNavigateTab = useCallback(async () => {
    const tabId = selectedTabId;
    const url = addressDraft.trim();
    if (!tabId || showingDesktopSnapshot || navigatingTab) return;
    if (!url) {
      setCaptureError("Enter an address for this browser tab.");
      addressInputRef.current?.focus();
      return;
    }
    const requestId = navigateTabRequestIdRef.current + 1;
    navigateTabRequestIdRef.current = requestId;
    setNavigatingTab(true);
    setCaptureError(null);
    setAttachmentNotice(null);
    const result = await navigateTab({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        tabId,
        url,
      },
    });
    if (navigateTabRequestIdRef.current !== requestId) return;
    setNavigatingTab(false);
    if (result._tag === "Failure") {
      if (selectedTabIdRef.current === tabId) {
        setCaptureError(formatCommandError(result, "This browser address could not be opened."));
      }
      return;
    }
    setOptimisticSessions((current) => upsertPreviewSessionSnapshot(current, result.value));
    if (selectedTabIdRef.current === tabId) {
      setAddressDraft(result.value.navStatus._tag === "Idle" ? url : result.value.navStatus.url);
      setAddressFocused(false);
      addressInputRef.current?.blur();
    }
    listQuery.refresh();
  }, [
    addressDraft,
    listQuery.refresh,
    navigateTab,
    navigatingTab,
    props.environmentId,
    props.threadId,
    selectedTabId,
    showingDesktopSnapshot,
  ]);
  const browserBusy =
    capturing || capturingLocalMarkup || gatewayOpening || creatingTab || navigatingTab;
  const browserUrl = showingDesktopSnapshot
    ? snapshot?.url
    : liveNavigation?.url || livePreviewUrl || undefined;
  useEffect(() => {
    if (!addressFocused && !navigatingTab) {
      setAddressDraft(browserUrl ?? "");
    }
  }, [addressFocused, browserUrl, navigatingTab, selectedTabId]);
  const annotateDisabled =
    browserBusy ||
    (showingDesktopSnapshot
      ? desktopMarkupSeed.value === null
      : !effectiveLiveTarget || !liveReady);
  const content = (() => {
    if (sessions.length === 0 && !listQuery.isPending) {
      return (
        <View className="flex-1 items-center justify-center bg-sheet px-5">
          <EmptyState
            variant="plain"
            title="No browser session"
            detail="Create a tab here, or open one from another connected T3 client."
            actionLabel="New tab"
            onAction={() => void handleCreateTab()}
          />
        </View>
      );
    }
    if (showingDesktopSnapshot) {
      if (!snapshot) {
        if (captureError && !capturing) {
          return (
            <View className="flex-1 items-center justify-center bg-sheet px-5">
              <EmptyState
                variant="plain"
                title="Could not capture desktop snapshot"
                detail={captureError}
                actionLabel="Retry"
                onAction={showDesktopSnapshot}
              />
            </View>
          );
        }
        return (
          <View className="flex-1 items-center justify-center gap-3 bg-sheet px-6">
            <ActivityIndicator />
            <Text className="text-center text-sm text-foreground-muted">
              Capturing the desktop browser…
            </Text>
          </View>
        );
      }
      return <SnapshotImage snapshot={snapshot} capturing={capturing} />;
    }
    if (selectedSession?.navStatus._tag === "Idle") {
      return (
        <View className="flex-1 items-center justify-center bg-sheet px-5">
          <EmptyState
            variant="plain"
            title="New browser tab"
            detail="Enter an address above to open a website."
            actionLabel="Enter address"
            onAction={() => addressInputRef.current?.focus()}
          />
        </View>
      );
    }
    if (effectiveLiveTarget && livePreviewUrl) {
      return (
        <MobileLivePreview
          ref={livePreviewRef}
          key={`${selectedTabId ?? "browser"}:${effectiveLiveTarget.uri}`}
          annotationSourceUrl={livePreviewUrl}
          isolatedSession={effectiveLiveTarget.isolatedSession}
          uri={effectiveLiveTarget.uri}
          onGatewayExpired={reopenLiveGateway}
          onNavigationChange={setLiveNavigation}
          onReadyChange={setLiveReady}
        />
      );
    }
    if (gatewayEligible) {
      if (gatewayError && !gatewayOpening) {
        return (
          <View className="flex-1 items-center justify-center bg-sheet px-5">
            <EmptyState
              variant="plain"
              title="Could not open browser"
              detail={gatewayError}
              actionLabel="Retry"
              onAction={() => {
                if (!selectedTabId) return;
                if (livePreviewUrl) issueLiveGatewayRequest(selectedTabId, livePreviewUrl);
              }}
            />
          </View>
        );
      }
      return (
        <View className="flex-1 items-center justify-center gap-3 bg-sheet px-6">
          <ActivityIndicator />
          <Text className="text-center text-sm text-foreground-muted">
            Opening Browser through the desktop…
          </Text>
        </View>
      );
    }
    if (liveTarget?.kind === "unavailable") {
      return (
        <View className="flex-1 items-center justify-center bg-sheet px-5">
          <EmptyState
            variant="plain"
            title="Browser unavailable"
            detail={liveTarget.detail}
            actionLabel="Use desktop snapshot"
            onAction={showDesktopSnapshot}
          />
        </View>
      );
    }
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-sheet px-6">
        <ActivityIndicator />
        <Text className="text-center text-sm text-foreground-muted">Preparing Browser…</Text>
      </View>
    );
  })();

  return (
    <View className="flex-1 border-l border-border bg-sheet" style={{ paddingTop: topInset }}>
      <View className="border-b border-border bg-sheet px-3 pb-2 pt-2">
        <View className="flex-row items-center gap-2">
          <PreviewTabPicker
            creating={creatingTab}
            sessions={sessions}
            selectedTabId={selectedTabId}
            onCreate={() => void handleCreateTab()}
            onSelect={selectBrowserTab}
          />
          {props.onFullscreenChange ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                props.fullscreen ? "Exit full screen browser" : "Open browser full screen"
              }
              className="size-10 items-center justify-center rounded-full bg-subtle active:opacity-70"
              onPress={() => props.onFullscreenChange?.(!props.fullscreen)}
            >
              <SymbolView
                name={
                  props.fullscreen
                    ? "arrow.down.right.and.arrow.up.left"
                    : "arrow.up.left.and.arrow.down.right"
                }
                size={16}
                type="monochrome"
              />
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              showingDesktopSnapshot ? "Annotate desktop snapshot" : "Annotate browser"
            }
            disabled={annotateDisabled}
            className="size-10 items-center justify-center rounded-full bg-primary active:opacity-70 disabled:opacity-45"
            onPress={() => void handleAnnotate()}
          >
            <SymbolView name="pencil" size={17} tintColor="#ffffff" type="monochrome" />
          </Pressable>
        </View>
        <View className="mt-2 flex-row items-center gap-1.5">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Go back"
            disabled={showingDesktopSnapshot || !liveNavigation?.canGoBack}
            className="size-9 items-center justify-center rounded-full bg-subtle active:opacity-70 disabled:opacity-35"
            onPress={() => livePreviewRef.current?.goBack()}
          >
            <SymbolView name="chevron.left" size={15} type="monochrome" />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Go forward"
            disabled={showingDesktopSnapshot || !liveNavigation?.canGoForward}
            className="size-9 items-center justify-center rounded-full bg-subtle active:opacity-70 disabled:opacity-35"
            onPress={() => livePreviewRef.current?.goForward()}
          >
            <SymbolView name="chevron.right" size={15} type="monochrome" />
          </Pressable>
          <View className="h-9 min-w-0 flex-1 flex-row items-center gap-2 rounded-xl bg-subtle px-3">
            <SymbolView name="globe" size={13} type="monochrome" />
            <TextInput
              ref={addressInputRef}
              accessibilityLabel="Browser address"
              autoCapitalize="none"
              autoCorrect={false}
              blurOnSubmit
              className="h-9 min-h-0 min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 py-0 text-xs"
              editable={!showingDesktopSnapshot && selectedTabId !== null && !navigatingTab}
              keyboardType="url"
              placeholder={selectedTabId ? "Enter address" : "No address"}
              returnKeyType="go"
              selectTextOnFocus
              value={addressDraft}
              onBlur={() => {
                setAddressFocused(false);
                if (addressDraft.trim().length === 0 && browserUrl) {
                  setAddressDraft(browserUrl);
                }
              }}
              onChangeText={setAddressDraft}
              onFocus={() => setAddressFocused(true)}
              onSubmitEditing={() => void handleNavigateTab()}
            />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              showingDesktopSnapshot ? "Refresh desktop snapshot" : "Reload browser"
            }
            disabled={!selectedTabId || browserBusy}
            className="size-9 items-center justify-center rounded-full bg-subtle active:opacity-70 disabled:opacity-45"
            onPress={() => {
              listQuery.refresh();
              if (showingDesktopSnapshot) {
                if (selectedTabId) void captureSnapshot(selectedTabId);
                return;
              }
              if (effectiveLiveTarget?.isolatedSession) {
                reopenLiveGateway();
                return;
              }
              if (livePreviewRef.current) {
                livePreviewRef.current.reload();
              } else if (gatewayEligible && selectedTabId && livePreviewUrl) {
                issueLiveGatewayRequest(selectedTabId, livePreviewUrl);
              }
            }}
          >
            {browserBusy ? (
              <ActivityIndicator size="small" />
            ) : (
              <SymbolView name="arrow.clockwise" size={15} type="monochrome" />
            )}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              showingDesktopSnapshot ? "Return to browser" : "Use desktop snapshot"
            }
            disabled={!selectedTabId || browserBusy}
            className="size-9 items-center justify-center rounded-full bg-subtle active:opacity-70 disabled:opacity-45"
            onPress={() => {
              if (showingDesktopSnapshot) {
                setShowingDesktopSnapshot(false);
                setCaptureError(null);
                return;
              }
              showDesktopSnapshot();
            }}
          >
            <SymbolView
              name={showingDesktopSnapshot ? "globe" : "photo"}
              size={15}
              type="monochrome"
            />
          </Pressable>
        </View>
        {showingDesktopSnapshot && snapshot ? (
          <Text className="mt-2 text-2xs text-foreground-muted">
            Desktop frame captured {relativeTime(snapshot.capturedAt)} ago ·{" "}
            {snapshot.elements.length} selectable element
            {snapshot.elements.length === 1 ? "" : "s"}
          </Text>
        ) : null}
        {showingDesktopSnapshot && snapshotChanged ? (
          <Text className="mt-1 text-2xs font-t3-bold text-amber-700 dark:text-amber-300">
            The desktop browser changed. Refresh this frame before marking the latest page.
          </Text>
        ) : null}
        {!showingDesktopSnapshot && liveTarget?.kind === "unavailable" && !gatewayEligible ? (
          <Text className="mt-1 text-2xs leading-snug text-foreground-muted">
            {liveTarget.detail}
          </Text>
        ) : null}
        {(showingDesktopSnapshot ? desktopMarkupSeed.error : null) || captureError ? (
          <Text className="mt-1 text-2xs leading-snug text-danger-foreground">
            {(showingDesktopSnapshot ? desktopMarkupSeed.error : null) ?? captureError}
          </Text>
        ) : null}
        {attachmentNotice ? (
          <Text className="mt-1 text-2xs font-t3-bold text-primary">{attachmentNotice}</Text>
        ) : null}
      </View>
      {content}
      <ImageMarkupModal
        attachment={markupModalSeed?.attachment ?? null}
        semanticElements={markupSemanticElements}
        visible={markupVisible && markupModalSeed !== null}
        onCancel={() => {
          setMarkupVisible(false);
          setMarkupModalSeed(null);
        }}
        onDone={(attachment) => void handleMarkupDone(attachment)}
      />
    </View>
  );
}
