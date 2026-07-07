import { isLiquidGlassSupported, LiquidGlassView } from "@callstack/liquid-glass";
import type {
  EnvironmentId,
  MessageId,
  ModelSelection,
  OrchestrationThreadShell,
  ProviderInteractionMode,
  RuntimeMode,
  ServerConfig as T3ServerConfig,
} from "@t3tools/contracts";
import {
  detectComposerTrigger,
  replaceTextRange,
  serializeComposerFileLink,
  type ComposerTrigger,
} from "@t3tools/shared/composerTrigger";
import type { ReactNode } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  useColorScheme,
  View,
  type ViewStyle,
} from "react-native";
import ImageViewing from "react-native-image-viewing";
import { useThemeColor } from "../../lib/useThemeColor";
import { scopedThreadKey } from "../../lib/scopedEntities";

import { AppText as Text } from "../../components/AppText";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import {
  ComposerEditor,
  type ComposerEditorHandle,
  type ComposerEditorSelection,
} from "../../components/ComposerEditor";
import {
  ComposerToolbarButton,
  ComposerToolbarRow,
  ComposerToolbarScroller,
  ComposerToolbarTrigger,
} from "../../components/ComposerToolbarTrigger";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { ProviderIcon } from "../../components/ProviderIcon";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import type { RemoteClientConnectionState } from "../../lib/connection";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";
import {
  applyProviderOptionMenuEvent,
  buildProviderOptionMenuActions,
  providerOptionsConfigurationLabel,
  resolveProviderOptionDescriptors,
} from "../../lib/providerOptions";
import { useComposerPathSearch } from "../../state/use-composer-path-search";
import { ComposerCommandPopover, type ComposerCommandItem } from "./ComposerCommandPopover";

/**
 * Height of the collapsed composer (pill + vertical padding, excluding safe-area inset).
 * Exported so the parent can compute feed overlap / content insets.
 */
export const COMPOSER_COLLAPSED_CHROME = 60;

/**
 * Height of the expanded composer (card + toolbar + vertical padding, excluding safe-area inset).
 * Used by the parent to compute the larger feed bottom inset when the composer is focused.
 */
export const COMPOSER_EXPANDED_CHROME = 174;

export interface ThreadComposerProps {
  readonly draftMessage: string;
  readonly draftAttachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly placeholder: string;
  readonly contentMaxWidth?: number;
  readonly bottomInset?: number;
  readonly connectionState: RemoteClientConnectionState;
  readonly connectionError: string | null;
  readonly environmentLabel: string | null;
  /**
   * Message sync phase for the selected thread (drives the status pill):
   * "loading" = first fetch, nothing to show yet; "syncing" = cached messages
   * are on screen while they reconcile with the server.
   */
  readonly threadSyncPhase?: "loading" | "syncing" | null;
  readonly selectedThread: OrchestrationThreadShell;
  readonly serverConfig: T3ServerConfig | null;
  readonly queueCount: number;
  readonly activeThreadBusy: boolean;
  readonly environmentId: EnvironmentId;
  readonly projectCwd: string | null;
  readonly editorRef?: RefObject<ComposerEditorHandle | null>;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onPickDraftImages: () => Promise<void>;
  readonly onNativePasteImages: (uris: ReadonlyArray<string>) => Promise<void>;
  readonly onRemoveDraftImage: (imageId: string) => void;
  readonly onStopThread: () => void;
  readonly onSendMessage: () => Promise<MessageId | null>;
  readonly onUpdateModelSelection: (modelSelection: ModelSelection) => void;
  readonly onUpdateRuntimeMode: (runtimeMode: RuntimeMode) => void;
  readonly onUpdateInteractionMode: (interactionMode: ProviderInteractionMode) => void;
  readonly onReconnectEnvironment: () => void;
  readonly onExpandedChange?: (expanded: boolean) => void;
}

/**
 * The pill / card container — renders as LiquidGlassView on supported
 * iOS 26+ devices (progressive blur, native morph), opaque View otherwise.
 */
function ComposerSurface(props: {
  readonly children: ReactNode;
  readonly style: ViewStyle;
  readonly isDarkMode: boolean;
}) {
  // Drop shadow lives on a wrapper: `overflow: "hidden"` on the surface itself
  // (needed to clip content to the pill shape) would clip the shadow on iOS.
  const shadowStyle: ViewStyle = {
    borderRadius: props.style.borderRadius,
    shadowColor: "#000000",
    shadowOpacity: props.isDarkMode ? 0.35 : 0.12,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  };

  if (isLiquidGlassSupported) {
    return (
      <View style={shadowStyle}>
        <LiquidGlassView
          effect="regular"
          interactive
          colorScheme={props.isDarkMode ? "dark" : "light"}
          style={props.style}
        >
          {props.children}
        </LiquidGlassView>
      </View>
    );
  }

  return (
    <View style={shadowStyle}>
      <View
        style={[
          props.style,
          {
            backgroundColor: props.isDarkMode ? "rgba(44,44,46,0.96)" : "rgba(255,255,255,0.96)",
            borderWidth: 1,
            borderColor: props.isDarkMode ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
          },
        ]}
      >
        {props.children}
      </View>
    </View>
  );
}

type ComposerStatusPillState = {
  readonly kind: "unavailable" | "reconnecting" | "syncing";
  readonly label: string;
};

function composerConnectionStatus(input: {
  readonly connectionError: string | null;
  readonly connectionState: RemoteClientConnectionState;
  readonly environmentLabel: string | null;
  readonly threadSyncPhase?: "loading" | "syncing" | null;
}): ComposerStatusPillState | null {
  const environmentLabel = input.environmentLabel ?? "Environment";

  switch (input.connectionState) {
    case "connecting":
    case "reconnecting":
      return {
        kind: "reconnecting",
        label:
          input.connectionError === null
            ? `Reconnecting to ${environmentLabel}...`
            : `Failed to connect. Retrying ${environmentLabel}...`,
      };
    case "offline":
      return { kind: "unavailable", label: "You are offline" };
    case "error":
      return {
        kind: "unavailable",
        label: input.connectionError
          ? `Failed to connect to ${environmentLabel}: ${input.connectionError}`
          : `Failed to connect to ${environmentLabel}`,
      };
    case "available":
      return { kind: "unavailable", label: `${environmentLabel} is not connected` };
    case "connected":
      break;
  }

  // Connected: the pill is the single loading/sync indicator. One stable
  // label per open — "Loading" when starting from scratch, "Syncing" when
  // cached messages are already visible.
  switch (input.threadSyncPhase) {
    case "loading":
      return { kind: "syncing", label: "Loading messages..." };
    case "syncing":
      return { kind: "syncing", label: "Syncing messages..." };
    default:
      return null;
  }
}

const ComposerConnectionStatusPill = memo(function ComposerConnectionStatusPill(props: {
  readonly onPress: () => void;
  readonly status: ComposerStatusPillState;
}) {
  const isReconnecting = props.status.kind !== "unavailable";

  return (
    <View className="items-center pb-2">
      <Pressable
        accessibilityRole="button"
        onPress={props.onPress}
        className="max-w-full flex-row items-center gap-2 rounded-full bg-white/90 px-3 py-2 shadow-sm active:opacity-70 dark:bg-neutral-900/90"
      >
        {isReconnecting ? (
          <ActivityIndicator size="small" color="#8e8e93" />
        ) : (
          <View className="h-2 w-2 rounded-full bg-red-500" />
        )}
        <Text
          className="max-w-[260px] text-sm font-t3-bold leading-snug text-foreground"
          numberOfLines={1}
        >
          {props.status.label}
        </Text>
      </Pressable>
    </View>
  );
});

export const ThreadComposer = memo(function ThreadComposer(props: ThreadComposerProps) {
  const isDarkMode = useColorScheme() === "dark";
  const foregroundColor = useThemeColor("--color-foreground");
  const bodyText = useScaledTextRole("body");
  const fallbackInputRef = useRef<ComposerEditorHandle>(null);
  const inputRef = props.editorRef ?? fallbackInputRef;
  const [isFocused, setIsFocused] = useState(false);
  const wasExpandedBeforePreviewRef = useRef(false);
  const inFlightThreadIdsRef = useRef(new Set<string>());
  const { onExpandedChange } = props;

  const [previewImageUri, setPreviewImageUri] = useState<string | null>(null);
  const hasContent = props.draftMessage.trim().length > 0 || props.draftAttachments.length > 0;
  const isExpanded = isFocused;
  const canSend = hasContent;

  const onPressImage = useCallback(
    (uri: string) => {
      wasExpandedBeforePreviewRef.current = isFocused;
      setPreviewImageUri(uri);
    },
    [isFocused],
  );

  const closePreview = useCallback(() => {
    setPreviewImageUri(null);
    if (wasExpandedBeforePreviewRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [inputRef]);

  const handleFocus = useCallback(() => {
    setIsFocused(true);
    onExpandedChange?.(true);
  }, [onExpandedChange]);

  const handleBlur = useCallback(() => {
    setIsFocused(false);
    onExpandedChange?.(false);
  }, [onExpandedChange]);
  const showStopAction =
    props.selectedThread.session?.status === "running" ||
    props.selectedThread.session?.status === "starting";

  const sendLabel =
    props.connectionState !== "connected" || props.activeThreadBusy || props.queueCount > 0
      ? "Queue"
      : "Send";
  const currentModelSelection = props.selectedThread.modelSelection;
  const currentRuntimeMode = props.selectedThread.runtimeMode;
  const currentInteractionMode = props.selectedThread.interactionMode ?? "default";
  const connectionStatus = composerConnectionStatus({
    connectionError: props.connectionError,
    connectionState: props.connectionState,
    environmentLabel: props.environmentLabel,
    threadSyncPhase: props.threadSyncPhase,
  });
  const toolbarFadeOpaque = isDarkMode ? "rgba(0,0,0,0.95)" : "rgba(255,255,255,0.95)";
  const toolbarFadeTransparent = isDarkMode ? "rgba(0,0,0,0)" : "rgba(255,255,255,0)";
  const selectedProviderStatus = useMemo(() => {
    if (!props.serverConfig) return null;
    return (
      props.serverConfig.providers.find(
        (p) => p.instanceId === props.selectedThread.modelSelection.instanceId,
      ) ?? null
    );
  }, [props.serverConfig, props.selectedThread.modelSelection.instanceId]);

  // ── Trigger detection ────────────────────────────────────
  const [composerSelection, setComposerSelection] = useState(() => ({
    start: props.draftMessage.length,
    end: props.draftMessage.length,
  }));

  const handleSelectionChange = useCallback((selection: ComposerEditorSelection) => {
    setComposerSelection(selection);
  }, []);
  useEffect(() => {
    const end = props.draftMessage.length;
    setComposerSelection((selection) => {
      const start = Math.min(selection.start, end);
      const selectionEnd = Math.min(selection.end, end);
      if (start === selection.start && selectionEnd === selection.end) {
        return selection;
      }
      return { start, end: selectionEnd };
    });
  }, [props.draftMessage.length]);

  const composerTrigger = useMemo<ComposerTrigger | null>(() => {
    if (composerSelection.start !== composerSelection.end) {
      return null;
    }
    return detectComposerTrigger(props.draftMessage, composerSelection.end);
  }, [composerSelection, props.draftMessage]);
  const pathSearch = useComposerPathSearch({
    environmentId: props.environmentId,
    cwd: composerTrigger?.kind === "path" ? props.projectCwd : null,
    query: composerTrigger?.kind === "path" ? composerTrigger.query : null,
  });

  const composerMenuItems: ComposerCommandItem[] = useMemo(() => {
    if (!composerTrigger) return [];

    if (composerTrigger.kind === "slash-command") {
      const q = composerTrigger.query.toLowerCase();
      const allBuiltIn = [
        {
          id: "cmd:model",
          type: "slash-command" as const,
          command: "model",
          label: "/model",
          description: "Switch model",
        },
        {
          id: "cmd:plan",
          type: "slash-command" as const,
          command: "plan",
          label: "/plan",
          description: "Switch to plan mode",
        },
        {
          id: "cmd:default",
          type: "slash-command" as const,
          command: "default",
          label: "/default",
          description: "Switch to default mode",
        },
      ];
      const builtIn = allBuiltIn.filter((item) => item.command.includes(q));

      const providerCommands: ComposerCommandItem[] = [];
      for (const cmd of selectedProviderStatus?.slashCommands ?? []) {
        if (!cmd.name.toLowerCase().includes(q)) continue;
        providerCommands.push({
          id: `pcmd:${cmd.name}`,
          type: "provider-slash-command" as const,
          command: cmd,
          label: `/${cmd.name}`,
          description: cmd.description ?? "",
        });
      }

      return [...builtIn, ...providerCommands];
    }

    if (composerTrigger.kind === "skill") {
      const enabledSkills = (selectedProviderStatus?.skills ?? []).filter((s) => s.enabled);
      const normalizedQuery = normalizeSearchQuery(composerTrigger.query, {
        trimLeadingPattern: /^\$+/,
      });

      if (!normalizedQuery) {
        return enabledSkills.slice(0, 20).map((skill) => ({
          id: `skill:${skill.name}`,
          type: "skill" as const,
          skill,
          label: skill.displayName ?? skill.name,
          description: skill.shortDescription ?? skill.description ?? "",
        }));
      }

      const ranked: Array<{
        item: (typeof enabledSkills)[number];
        score: number;
        tieBreaker: string;
      }> = [];
      for (const skill of enabledSkills) {
        const displayLabel = (skill.displayName ?? skill.name).toLowerCase();
        const scores = [
          scoreQueryMatch({
            value: skill.name.toLowerCase(),
            query: normalizedQuery,
            exactBase: 0,
            prefixBase: 2,
            boundaryBase: 4,
            includesBase: 6,
            fuzzyBase: 100,
            boundaryMarkers: ["-", "_", "/"],
          }),
          scoreQueryMatch({
            value: displayLabel,
            query: normalizedQuery,
            exactBase: 1,
            prefixBase: 3,
            boundaryBase: 5,
            includesBase: 7,
            fuzzyBase: 110,
          }),
          scoreQueryMatch({
            value: skill.shortDescription?.toLowerCase() ?? "",
            query: normalizedQuery,
            exactBase: 20,
            prefixBase: 22,
            boundaryBase: 24,
            includesBase: 26,
          }),
          scoreQueryMatch({
            value: skill.description?.toLowerCase() ?? "",
            query: normalizedQuery,
            exactBase: 30,
            prefixBase: 32,
            boundaryBase: 34,
            includesBase: 36,
          }),
        ].filter((s): s is number => s !== null);

        if (scores.length > 0) {
          insertRankedSearchResult(
            ranked,
            {
              item: skill,
              score: Math.min(...scores),
              tieBreaker: `${displayLabel}\u0000${skill.name}`,
            },
            20,
          );
        }
      }

      return ranked.map(({ item: skill }) => ({
        id: `skill:${skill.name}`,
        type: "skill" as const,
        skill,
        label: skill.displayName ?? skill.name,
        description: skill.shortDescription ?? skill.description ?? "",
      }));
    }

    if (composerTrigger.kind === "path") {
      return pathSearch.entries.map((entry) => {
        const parts = entry.path.split("/");
        return {
          id: `path:${entry.path}`,
          type: "path" as const,
          path: entry.path,
          kind: entry.kind,
          label: parts[parts.length - 1] ?? entry.path,
          description: parts.length > 1 ? parts.slice(0, -1).join("/") : "",
        };
      });
    }

    return [];
  }, [composerTrigger, pathSearch.entries, selectedProviderStatus]);

  // ── Handle command selection ──────────────────────────────
  const { onChangeDraftMessage, onUpdateInteractionMode, draftMessage, onSendMessage } = props;

  const handleSend = useCallback(async () => {
    const threadKey = scopedThreadKey(props.environmentId, props.selectedThread.id);
    if (inFlightThreadIdsRef.current.has(threadKey)) return;
    inFlightThreadIdsRef.current.add(threadKey);
    try {
      await onSendMessage();
    } finally {
      inFlightThreadIdsRef.current.delete(threadKey);
    }
  }, [onSendMessage, props.environmentId, props.selectedThread.id]);
  const handleCommandSelect = useCallback(
    (item: ComposerCommandItem) => {
      if (!composerTrigger) return;

      if (
        item.type === "slash-command" &&
        (item.command === "plan" || item.command === "default")
      ) {
        const result = replaceTextRange(
          draftMessage,
          composerTrigger.rangeStart,
          composerTrigger.rangeEnd,
          "",
        );
        setComposerSelection({ start: result.cursor, end: result.cursor });
        onChangeDraftMessage(result.text);
        onUpdateInteractionMode(item.command);
        return;
      }

      let replacement = "";
      if (item.type === "path") {
        replacement = `${serializeComposerFileLink(item.path)} `;
      } else if (item.type === "skill") {
        replacement = `$${item.skill.name} `;
      } else if (item.type === "slash-command") {
        replacement = `/${item.command} `;
      } else if (item.type === "provider-slash-command") {
        replacement = `/${item.command.name} `;
      }

      const result = replaceTextRange(
        draftMessage,
        composerTrigger.rangeStart,
        composerTrigger.rangeEnd,
        replacement,
      );
      setComposerSelection({ start: result.cursor, end: result.cursor });
      onChangeDraftMessage(result.text);
    },
    [composerTrigger, draftMessage, onChangeDraftMessage, onUpdateInteractionMode],
  );

  // ── Model menu ───────────────────────────────────────────
  const modelOptions = useMemo(
    () => buildModelOptions(props.serverConfig, currentModelSelection),
    [props.serverConfig, currentModelSelection],
  );
  const providerGroups = useMemo(() => groupByProvider(modelOptions), [modelOptions]);
  const currentModelOption =
    modelOptions.find(
      (option) =>
        option.selection.instanceId === currentModelSelection.instanceId &&
        option.selection.model === currentModelSelection.model,
    ) ?? null;
  const providerOptionDescriptors = useMemo(
    () =>
      resolveProviderOptionDescriptors({
        capabilities: currentModelOption?.capabilities,
        selections: currentModelSelection.options,
      }),
    [currentModelOption?.capabilities, currentModelSelection.options],
  );
  const configurationLabel = useMemo(
    () => providerOptionsConfigurationLabel(providerOptionDescriptors),
    [providerOptionDescriptors],
  );
  const modelMenuActions = useMemo(
    () =>
      providerGroups.map((group) => ({
        id: `provider:${group.providerKey}`,
        title: group.providerLabel,
        subtitle: group.models.find(
          (model) =>
            model.selection.instanceId === currentModelSelection.instanceId &&
            model.selection.model === currentModelSelection.model,
        )?.label,
        subactions: group.models.map((option) => ({
          id: `model:${option.key}`,
          title: option.label,
          state:
            option.selection.instanceId === currentModelSelection.instanceId &&
            option.selection.model === currentModelSelection.model
              ? ("on" as const)
              : undefined,
        })),
      })),
    [providerGroups, currentModelSelection],
  );

  // ── Options menu ─────────────────────────────────────────
  const optionsMenuActions = useMemo(
    () => [
      ...buildProviderOptionMenuActions(providerOptionDescriptors),
      {
        id: "options-runtime",
        title: "Runtime",
        subtitle:
          currentRuntimeMode === "approval-required"
            ? "Approve actions"
            : currentRuntimeMode === "auto-accept-edits"
              ? "Auto-accept edits"
              : "Full access",
        subactions: [
          { id: "options:runtime:approval-required", title: "Approve actions" },
          { id: "options:runtime:auto-accept-edits", title: "Auto-accept edits" },
          { id: "options:runtime:full-access", title: "Full access" },
        ].map((option) => {
          const value = option.id.replace("options:runtime:", "");
          return {
            id: option.id,
            title: option.title,
            state: currentRuntimeMode === value ? ("on" as const) : undefined,
          };
        }),
      },
      {
        id: "options-interaction",
        title: "Interaction",
        subtitle: currentInteractionMode === "plan" ? "Plan" : "Default",
        subactions: [
          { id: "options:interaction:default", title: "Default" },
          { id: "options:interaction:plan", title: "Plan" },
        ].map((option) => {
          const value = option.id.replace("options:interaction:", "");
          return {
            id: option.id,
            title: option.title,
            state: currentInteractionMode === value ? ("on" as const) : undefined,
          };
        }),
      },
    ],
    [currentInteractionMode, currentRuntimeMode, providerOptionDescriptors],
  );

  // ── Menu handlers ────────────────────────────────────────
  function handleModelMenuAction(event: string) {
    if (!event.startsWith("model:")) {
      return;
    }
    const modelKey = event.slice("model:".length);
    const option = modelOptions.find((o) => o.key === modelKey);
    if (option) {
      props.onUpdateModelSelection(option.selection);
    }
  }

  function handleOptionsMenuAction(event: string) {
    const providerOptions = applyProviderOptionMenuEvent(providerOptionDescriptors, event);
    if (providerOptions) {
      props.onUpdateModelSelection({
        ...currentModelSelection,
        options: providerOptions,
      });
      return;
    }
    if (event.startsWith("options:runtime:")) {
      const runtimeMode = event.slice("options:runtime:".length) as RuntimeMode;
      props.onUpdateRuntimeMode(runtimeMode);
      return;
    }
    if (event.startsWith("options:interaction:")) {
      const interactionMode = event.slice("options:interaction:".length) as ProviderInteractionMode;
      props.onUpdateInteractionMode(interactionMode);
    }
  }

  return (
    <View
      style={{
        paddingHorizontal: 16,
        paddingTop: isExpanded ? 8 : 6,
        paddingBottom: (props.bottomInset ?? 0) + (isExpanded ? 8 : 6),
        experimental_backgroundImage: isDarkMode
          ? "linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0.6) 55%, rgba(0,0,0,0.9) 100%)"
          : "linear-gradient(to bottom, rgba(255,255,255,0) 0%, rgba(255,255,255,0.6) 55%, rgba(255,255,255,0.9) 100%)",
      }}
    >
      <View
        className="w-full"
        style={{ alignSelf: "center", maxWidth: props.contentMaxWidth, position: "relative" }}
      >
        {composerTrigger && composerMenuItems.length > 0 ? (
          <View
            style={{
              position: "absolute",
              bottom: "100%",
              left: 0,
              right: 0,
              marginBottom: 8,
              zIndex: 10,
            }}
          >
            <ComposerCommandPopover
              items={composerMenuItems}
              triggerKind={composerTrigger.kind}
              isLoading={pathSearch.isPending}
              onSelect={handleCommandSelect}
            />
          </View>
        ) : null}

        {connectionStatus ? (
          <ComposerConnectionStatusPill
            status={connectionStatus}
            onPress={props.onReconnectEnvironment}
          />
        ) : null}

        <ComposerSurface
          isDarkMode={isDarkMode}
          style={
            isExpanded
              ? {
                  borderRadius: 20,
                  overflow: "hidden" as const,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                }
              : {
                  borderRadius: 999,
                  overflow: "hidden" as const,
                  flexDirection: "row" as const,
                  alignItems: "center" as const,
                  paddingLeft: 18,
                  paddingRight: 5,
                  paddingVertical: 5,
                }
          }
        >
          {/* Attachment strip — inside the card, above the text input */}
          {isExpanded ? (
            <View style={{ paddingBottom: props.draftAttachments.length > 0 ? 10 : 0 }}>
              <ComposerAttachmentStrip
                attachments={props.draftAttachments}
                onRemove={props.onRemoveDraftImage}
                onPressImage={onPressImage}
              />
            </View>
          ) : null}

          <View style={isExpanded ? undefined : { flex: 1, minWidth: 0 }}>
            <ComposerEditor
              ref={inputRef}
              multiline
              value={props.draftMessage}
              skills={selectedProviderStatus?.skills ?? []}
              selection={composerSelection}
              onChangeText={props.onChangeDraftMessage}
              onSelectionChange={handleSelectionChange}
              onPasteImages={(uris) => void props.onNativePasteImages(uris)}
              placeholder={props.placeholder}
              onFocus={handleFocus}
              onBlur={handleBlur}
              onSubmit={handleSend}
              scrollEnabled={isExpanded}
              contentInsetVertical={isExpanded ? 0 : 6}
              style={
                isExpanded
                  ? {
                      minHeight: 80,
                      maxHeight: 160,
                      paddingHorizontal: 4,
                      paddingVertical: 4,
                    }
                  : {
                      height: 36,
                    }
              }
              textStyle={{
                ...bodyText,
                color: foregroundColor,
                fontFamily: "DMSans_400Regular",
              }}
            />
          </View>
          {!isExpanded && props.draftAttachments.length > 0 ? (
            <View style={{ flexDirection: "row", gap: 4, paddingLeft: 4 }}>
              {props.draftAttachments.slice(0, 3).map((image) => (
                <Pressable key={image.id} onPress={() => onPressImage(image.previewUri)}>
                  <Image
                    source={{ uri: image.previewUri }}
                    className="bg-subtle"
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 8,
                    }}
                    resizeMode="cover"
                  />
                </Pressable>
              ))}
              {props.draftAttachments.length > 3 ? (
                <View
                  className="bg-subtle-strong"
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 8,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text className="text-foreground-muted text-2xs font-t3-bold">
                    +{props.draftAttachments.length - 3}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}
          {!isExpanded ? (
            showStopAction ? (
              <ControlPill icon="stop.fill" variant="danger" onPress={props.onStopThread} />
            ) : (
              <ControlPill
                icon="arrow.up"
                variant="primary"
                disabled={!canSend}
                onPress={handleSend}
              />
            )
          ) : null}
        </ComposerSurface>

        {/* Toolbar row — matches draft page layout (expanded only) */}
        {isExpanded ? (
          <ComposerToolbarRow paddingBottom={8} paddingHorizontal={0} paddingTop={8}>
            <ComposerToolbarScroller
              fadeOpaque={toolbarFadeOpaque}
              fadeTransparent={toolbarFadeTransparent}
            >
              <ComposerToolbarButton
                icon="plus"
                onPress={() => void props.onPickDraftImages()}
                showChevron={false}
              />
              <ControlPillMenu
                actions={modelMenuActions}
                onPressAction={({ nativeEvent }) => handleModelMenuAction(nativeEvent.event)}
              >
                <ComposerToolbarTrigger
                  accessibilityLabel="Model"
                  iconNode={
                    <ProviderIcon provider={currentModelOption?.providerDriver} size={16} />
                  }
                  label={currentModelOption?.label ?? currentModelSelection.model}
                />
              </ControlPillMenu>
              <ControlPillMenu
                actions={optionsMenuActions}
                onPressAction={({ nativeEvent }) => handleOptionsMenuAction(nativeEvent.event)}
              >
                <ComposerToolbarTrigger
                  accessibilityLabel="Configuration"
                  icon="slider.horizontal.3"
                  label={configurationLabel}
                />
              </ControlPillMenu>
              {showStopAction ? (
                <ComposerToolbarButton
                  icon="stop.fill"
                  variant="danger"
                  onPress={props.onStopThread}
                  showChevron={false}
                />
              ) : null}
            </ComposerToolbarScroller>
            <ComposerToolbarButton
              accessibilityLabel={sendLabel}
              icon="arrow.up"
              variant="primary"
              disabled={!canSend}
              onPress={handleSend}
              showChevron={false}
            />
          </ComposerToolbarRow>
        ) : null}

        {/* Queue count */}
        {props.queueCount > 0 ? (
          <Text className="text-xs text-foreground-muted" style={{ paddingTop: 8 }}>
            {props.queueCount} queued message{props.queueCount === 1 ? "" : "s"} will send
            automatically.
          </Text>
        ) : null}
      </View>

      <ImageViewing
        images={previewImageUri ? [{ uri: previewImageUri }] : []}
        imageIndex={0}
        visible={previewImageUri !== null}
        onRequestClose={closePreview}
        swipeToCloseEnabled
        doubleTapToZoomEnabled
      />
    </View>
  );
});
