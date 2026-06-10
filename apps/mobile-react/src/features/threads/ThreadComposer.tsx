import { isLiquidGlassSupported, LiquidGlassView } from "@callstack/liquid-glass";
import type {
  EnvironmentId,
  ModelSelection,
  OrchestrationThread,
  ProviderInteractionMode,
  RuntimeMode,
  ServerConfig as T3ServerConfig,
} from "@t3tools/contracts";
import {
  detectComposerTrigger,
  replaceTextRange,
  type ComposerTrigger,
} from "@t3tools/shared/composerTrigger";
import { TextInputWrapper } from "expo-paste-input";
import type { ReactNode } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Image,
  Pressable,
  TextInput as RNTextInput,
  useColorScheme,
  View,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
  type ViewStyle,
} from "react-native";
import ImageViewing from "react-native-image-viewing";
import { useThemeColor } from "../../lib/useThemeColor";

import { AppText as Text } from "../../components/AppText";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { ProviderIcon } from "../../components/ProviderIcon";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import type { RemoteClientConnectionState } from "../../lib/connection";
import { useNativePaste } from "../../lib/useNativePaste";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";
import { useComposerPathSearch } from "../../state/use-composer-path-search";
import { CLAUDE_AGENT_EFFORT_OPTIONS } from "./claudeEffortOptions";
import { ComposerCommandPopover, type ComposerCommandItem } from "./ComposerCommandPopover";

/**
 * Height of the collapsed composer (pill + vertical padding, excluding safe-area inset).
 * Exported so the parent can compute feed overlap / content insets.
 */
export const COMPOSER_COLLAPSED_CHROME = 68;

/**
 * Height of the expanded composer (card + toolbar + vertical padding, excluding safe-area inset).
 * Used by the parent to compute the larger feed bottom inset when the composer is focused.
 */
export const COMPOSER_EXPANDED_CHROME = 174;

/**
 * Height of the expanded-only toolbar below the text surface.
 * Used by the feed inset because KeyboardAvoidingLegendList only accounts for
 * keyboard height; the floating toolbar remains an additional overlay.
 */
export const COMPOSER_EXPANDED_TOOLBAR_CHROME = 54;

export interface ThreadComposerProps {
  readonly draftMessage: string;
  readonly draftAttachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly placeholder: string;
  readonly bottomInset?: number;
  readonly connectionState: RemoteClientConnectionState;
  readonly selectedThread: OrchestrationThread;
  readonly serverConfig: T3ServerConfig | null;
  readonly queueCount: number;
  readonly activeThreadBusy: boolean;
  readonly environmentId: EnvironmentId;
  readonly projectCwd: string | null;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onPickDraftImages: () => Promise<void>;
  readonly onNativePasteImages: (uris: ReadonlyArray<string>) => Promise<void>;
  readonly onRemoveDraftImage: (imageId: string) => void;
  readonly onRefresh: () => Promise<void>;
  readonly onStopThread: () => Promise<void>;
  readonly onSendMessage: () => void;
  readonly onUpdateModelSelection: (modelSelection: ModelSelection) => Promise<void>;
  readonly onUpdateRuntimeMode: (runtimeMode: RuntimeMode) => Promise<void>;
  readonly onUpdateInteractionMode: (interactionMode: ProviderInteractionMode) => Promise<void>;
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
  if (isLiquidGlassSupported) {
    return (
      <LiquidGlassView
        effect="clear"
        interactive
        tintColor={props.isDarkMode ? "rgba(44,44,46,0.5)" : "rgba(255,255,255,0.45)"}
        colorScheme={props.isDarkMode ? "dark" : "light"}
        style={props.style}
      >
        {props.children}
      </LiquidGlassView>
    );
  }

  return (
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
  );
}

function withModelSelectionOption(
  selection: ModelSelection,
  id: string,
  value: string | boolean | undefined,
): ModelSelection {
  const options = (selection.options ?? []).filter((option) => option.id !== id);
  return {
    ...selection,
    options: value === undefined ? options : [...options, { id, value }],
  };
}

export const ThreadComposer = memo(function ThreadComposer(props: ThreadComposerProps) {
  const isDarkMode = useColorScheme() === "dark";
  const themePlaceholderColor = useThemeColor("--color-placeholder");
  const placeholderColor = isDarkMode ? "#a1a1aa" : themePlaceholderColor;
  const foregroundColor = useThemeColor("--color-foreground");
  const inputRef = useRef<RNTextInput>(null);
  const inputValueRef = useRef(props.draftMessage);
  const [isFocused, setIsFocused] = useState(false);
  const wasExpandedBeforePreviewRef = useRef(false);
  const { onExpandedChange } = props;

  const [previewImageUri, setPreviewImageUri] = useState<string | null>(null);
  const hasContent = props.draftMessage.trim().length > 0 || props.draftAttachments.length > 0;
  const isExpanded = isFocused;
  const canSend = props.connectionState === "ready" && hasContent;

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
  }, []);

  useEffect(() => {
    onExpandedChange?.(isExpanded);
  }, [isExpanded, onExpandedChange]);

  useEffect(() => {
    if (inputValueRef.current === props.draftMessage) {
      return;
    }

    inputValueRef.current = props.draftMessage;
    if (props.draftMessage.length === 0) {
      inputRef.current?.clear();
      return;
    }

    inputRef.current?.setNativeProps({ text: props.draftMessage });
  }, [props.draftMessage]);

  const handleDraftMessageChange = useCallback(
    (value: string) => {
      inputValueRef.current = value;
      props.onChangeDraftMessage(value);
    },
    [props.onChangeDraftMessage],
  );

  const applyDraftMessage = useCallback(
    (value: string, cursor: number) => {
      inputValueRef.current = value;
      props.onChangeDraftMessage(value);
      inputRef.current?.setNativeProps({
        text: value,
        selection: { start: cursor, end: cursor },
      });
    },
    [props.onChangeDraftMessage],
  );

  const showStopAction =
    props.selectedThread.session?.status === "running" ||
    props.selectedThread.session?.status === "starting" ||
    props.queueCount > 0;

  const sendLabel = props.activeThreadBusy || props.queueCount > 0 ? "Queue" : "Send";
  const modelProvider = props.selectedThread.modelSelection?.instanceId ?? null;
  const currentModelSelection = props.selectedThread.modelSelection;
  const currentRuntimeMode = props.selectedThread.runtimeMode;
  const currentInteractionMode = props.selectedThread.interactionMode ?? "default";
  const selectedProviderStatus = useMemo(() => {
    if (!props.serverConfig) return null;
    return (
      props.serverConfig.providers.find(
        (p) => p.instanceId === props.selectedThread.modelSelection.instanceId,
      ) ?? null
    );
  }, [props.serverConfig, props.selectedThread.modelSelection.instanceId]);

  // Extract current model options (effort, fastMode, contextWindow)
  const selectedProviderDriver = selectedProviderStatus?.driver ?? null;
  const currentEffort =
    selectedProviderDriver === "claudeAgent"
      ? (getModelSelectionStringOptionValue(currentModelSelection, "effort") ?? "high")
      : "high";
  const currentFastMode =
    getModelSelectionBooleanOptionValue(currentModelSelection, "fastMode") ?? false;
  const currentContextWindow =
    selectedProviderDriver === "claudeAgent"
      ? (getModelSelectionStringOptionValue(currentModelSelection, "contextWindow") ?? "1M")
      : "1M";

  const handleNativePaste = useNativePaste((uris) => {
    void props.onNativePasteImages(uris);
  });

  // ── Trigger detection ────────────────────────────────────
  const [cursorPosition, setCursorPosition] = useState(0);

  const handleSelectionChange = useCallback(
    (event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      const { start } = event.nativeEvent.selection;
      setCursorPosition(start);
    },
    [],
  );

  const composerTrigger = useMemo<ComposerTrigger | null>(
    () => detectComposerTrigger(props.draftMessage, cursorPosition),
    [cursorPosition, props.draftMessage],
  );
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
  const { onUpdateInteractionMode, draftMessage, onSendMessage } = props;

  const handleSend = useCallback(() => {
    onSendMessage();
    inputValueRef.current = "";
    inputRef.current?.clear();
    inputRef.current?.blur();
  }, [onSendMessage]);
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
        setCursorPosition(result.cursor);
        applyDraftMessage(result.text, result.cursor);
        void onUpdateInteractionMode(item.command);
        return;
      }

      let replacement = "";
      if (item.type === "path") {
        replacement = `@${item.path} `;
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
      setCursorPosition(result.cursor);
      applyDraftMessage(result.text, result.cursor);
    },
    [applyDraftMessage, composerTrigger, draftMessage, onUpdateInteractionMode],
  );

  // ── Model menu ───────────────────────────────────────────
  const providerGroups = useMemo(() => {
    const options = buildModelOptions(props.serverConfig, currentModelSelection);
    return groupByProvider(options);
  }, [props.serverConfig, currentModelSelection]);

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
      {
        id: "options-effort",
        title: "Effort",
        subtitle: `${currentEffort.charAt(0).toUpperCase()}${currentEffort.slice(1)}`,
        subactions: CLAUDE_AGENT_EFFORT_OPTIONS.map((level) => ({
          id: `options:effort:${level}`,
          title: `${level}${level === "high" ? " (default)" : ""}`,
          state: currentEffort === level ? ("on" as const) : undefined,
        })),
      },
      {
        id: "options-fast-mode",
        title: "Fast Mode",
        subtitle: currentFastMode ? "On" : "Off",
        subactions: ([false, true] as const).map((value) => ({
          id: `options:fast-mode:${value ? "on" : "off"}`,
          title: value ? "On" : "Off",
          state: currentFastMode === value ? ("on" as const) : undefined,
        })),
      },
      {
        id: "options-context-window",
        title: "Context Window",
        subtitle: currentContextWindow,
        subactions: (["200k", "1M"] as const).map((value) => ({
          id: `options:context-window:${value}`,
          title: `${value}${value === "1M" ? " (default)" : ""}`,
          state: currentContextWindow === value ? ("on" as const) : undefined,
        })),
      },
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
    [
      currentEffort,
      currentFastMode,
      currentContextWindow,
      currentRuntimeMode,
      currentInteractionMode,
    ],
  );

  // ── Menu handlers ────────────────────────────────────────
  function handleModelMenuAction(event: string) {
    if (!event.startsWith("model:")) {
      return;
    }
    const modelKey = event.slice("model:".length);
    const options = buildModelOptions(props.serverConfig, currentModelSelection);
    const option = options.find((o) => o.key === modelKey);
    if (option) {
      void props.onUpdateModelSelection(option.selection);
    }
  }

  function handleOptionsMenuAction(event: string) {
    if (event.startsWith("options:effort:")) {
      const effort = event.slice("options:effort:".length);
      const updated: ModelSelection =
        selectedProviderDriver === "claudeAgent"
          ? withModelSelectionOption(
              currentModelSelection,
              "effort",
              effort as typeof currentEffort,
            )
          : currentModelSelection;
      void props.onUpdateModelSelection(updated);
      return;
    }
    if (event.startsWith("options:fast-mode:")) {
      const fastMode = event.endsWith(":on");
      const nextFast = fastMode || undefined;
      if (selectedProviderDriver === "opencode") {
        return;
      }
      const updated = withModelSelectionOption(currentModelSelection, "fastMode", nextFast);
      void props.onUpdateModelSelection(updated);
      return;
    }
    if (event.startsWith("options:context-window:")) {
      const contextWindow = event.slice("options:context-window:".length);
      const updated: ModelSelection =
        selectedProviderDriver === "claudeAgent"
          ? withModelSelectionOption(currentModelSelection, "contextWindow", contextWindow)
          : currentModelSelection;
      void props.onUpdateModelSelection(updated);
      return;
    }
    if (event.startsWith("options:runtime:")) {
      const runtimeMode = event.slice("options:runtime:".length) as RuntimeMode;
      void props.onUpdateRuntimeMode(runtimeMode);
      return;
    }
    if (event.startsWith("options:interaction:")) {
      const interactionMode = event.slice("options:interaction:".length) as ProviderInteractionMode;
      void props.onUpdateInteractionMode(interactionMode);
    }
  }

  return (
    <View
      style={{
        paddingHorizontal: 16,
        paddingTop: isExpanded ? 12 : 10,
        paddingBottom: (props.bottomInset ?? 0) + (isExpanded ? 4 : 10),
        experimental_backgroundImage: isDarkMode
          ? "linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0.85) 40%, rgba(0,0,0,0.95) 100%)"
          : "linear-gradient(to bottom, rgba(255,255,255,0) 0%, rgba(255,255,255,0.85) 40%, rgba(255,255,255,0.95) 100%)",
      }}
    >
      <View className="w-full" style={{ position: "relative" }}>
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
            <TextInputWrapper onPaste={handleNativePaste}>
              <RNTextInput
                ref={inputRef}
                multiline
                defaultValue={props.draftMessage}
                onChangeText={handleDraftMessageChange}
                onSelectionChange={handleSelectionChange}
                placeholder={props.placeholder}
                placeholderTextColor={placeholderColor}
                editable={props.connectionState === "ready"}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                textAlignVertical={isExpanded ? "top" : "center"}
                style={
                  isExpanded
                    ? {
                        minHeight: 80,
                        maxHeight: 160,
                        paddingHorizontal: 4,
                        paddingVertical: 4,
                        fontSize: 15,
                        lineHeight: 22,
                        color: foregroundColor,
                        fontFamily: "DMSans_400Regular",
                      }
                    : {
                        maxHeight: 36,
                        paddingVertical: 6,
                        fontSize: 15,
                        lineHeight: 20,
                        color: foregroundColor,
                        fontFamily: "DMSans_400Regular",
                      }
                }
              />
            </TextInputWrapper>
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
                  <Text className="text-foreground-muted text-[11px] font-t3-bold">
                    +{props.draftAttachments.length - 3}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}
          {!isExpanded ? (
            showStopAction ? (
              <ControlPill
                icon="stop.fill"
                variant="danger"
                onPress={() => void props.onStopThread()}
              />
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
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingTop: 10,
              gap: 8,
            }}
          >
            <ControlPill icon="plus" onPress={() => void props.onPickDraftImages()} />
            <ControlPillMenu
              actions={modelMenuActions}
              onPressAction={({ nativeEvent }) => handleModelMenuAction(nativeEvent.event)}
            >
              <ControlPill iconNode={<ProviderIcon provider={modelProvider} size={16} />} />
            </ControlPillMenu>
            <ControlPillMenu
              actions={optionsMenuActions}
              onPressAction={({ nativeEvent }) => handleOptionsMenuAction(nativeEvent.event)}
            >
              <ControlPill icon="slider.horizontal.3" />
            </ControlPillMenu>
            <ControlPill icon="arrow.clockwise" onPress={() => void props.onRefresh()} />
            {showStopAction ? (
              <ControlPill
                icon="stop.fill"
                variant="danger"
                onPress={() => void props.onStopThread()}
              />
            ) : null}
            <ControlPill
              icon="arrow.up"
              label={sendLabel}
              variant="primary"
              disabled={!canSend}
              onPress={handleSend}
            />
          </View>
        ) : null}

        {/* Queue count */}
        {props.queueCount > 0 ? (
          <Text
            className="text-foreground-muted"
            style={{
              fontSize: 12,
              lineHeight: 18,
              paddingTop: 8,
            }}
          >
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
