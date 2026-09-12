/* oxlint-disable react/no-array-index-key -- Captured table rows and columns have stable positions and may contain identical values. */
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { MenuAction } from "@react-native-menu/menu";
import { EnvironmentId } from "@t3tools/contracts";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, ScrollView, View } from "react-native";

import { AndroidHeaderIconButton, AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { AudioFilePreview } from "../../components/AudioFilePreview";
import { ControlPillMenu } from "../../components/ControlPill";
import { EmptyState } from "../../components/EmptyState";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import { useAttachmentDocument } from "../../lib/attachmentDocument";
import { nativeViewerErrorMessage } from "../../lib/attachmentDownload";
import { isFileBackedComposerAttachment } from "../../lib/composerImages";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { removeComposerDraftAttachment, useComposerDraft } from "../../state/use-composer-drafts";
import { FileMarkdownPreview } from "./FileMarkdownPreview";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { SourceFileSurface } from "./SourceFileSurface";
import { WorkspaceFileWebPreview } from "./WorkspaceFileWebPreview";

/**
 * Both the thread stack and the new-task sheet stack register this screen, so a chip in a
 * sent message and a chip in a draft open the same view a workspace file does.
 */
export type AttachmentFileRouteParams = {
  readonly environmentId?: string;
  readonly threadId?: string;
  readonly attachmentId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: string;
  /** Present for a draft attachment, which may still live only on this device. */
  readonly draftKey?: string;
};

type AttachmentFileScreenProps = StaticScreenProps<AttachmentFileRouteParams>;

/** Kinds this screen cannot render itself; the platform viewer is the primary presentation. */
function nativeViewerKind(kind: ReturnType<typeof useAttachmentDocument>["kind"]) {
  if (kind === "image") return "image" as const;
  if (kind === "pdf") return "pdf" as const;
  if (kind === "video" || kind === "unsupported") return "document" as const;
  return null;
}

function AttachmentDocumentBody(props: {
  readonly document: ReturnType<typeof useAttachmentDocument>;
  readonly name: string;
  readonly environmentId: EnvironmentId | null;
  readonly nativeViewer: "pending" | "open" | "unavailable" | null;
  readonly nativeError: string | null;
  readonly onOpenNative: () => void;
}) {
  const { document } = props;
  if (document.error) {
    return (
      <View className="flex-1 items-center justify-center bg-sheet px-6">
        <EmptyState
          title="File unavailable"
          detail={document.error}
          actionLabel="Try again"
          onAction={document.retry}
        />
      </View>
    );
  }
  if (props.nativeViewer !== null && props.nativeViewer !== "unavailable") {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-sheet px-6">
        <ActivityIndicator />
        <Text className="text-center text-sm text-foreground-muted">Opening in file viewer...</Text>
      </View>
    );
  }
  if (!document.uri || (document.needsText && !document.content)) {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-sheet px-6">
        <ActivityIndicator />
        <Text className="text-center text-sm text-foreground-muted">Loading file...</Text>
      </View>
    );
  }
  if (document.needsText && document.content) {
    const { content, table } = document;
    return (
      <View className="flex-1 bg-sheet">
        {content.truncated ? (
          <View className="border-b border-warning-border bg-warning px-4 py-2">
            <Text className="text-2xs font-t3-bold uppercase text-warning-foreground">
              Partial file
            </Text>
            <Text className="text-xs leading-snug text-warning-foreground">
              Preview limited to the first 1 MB. Save or share the file to read it in full.
            </Text>
          </View>
        ) : null}
        {table && document.activeMode === "table" ? (
          <ScrollView className="flex-1">
            {table.truncated ? (
              <View className="border-b border-warning-border bg-warning px-4 py-2">
                <Text className="text-xs leading-snug text-warning-foreground">
                  Table limited to the first 100 rows and 30 columns. Source shows the rest.
                </Text>
              </View>
            ) : null}
            <ScrollView horizontal>
              <View>
                {table.rows.map((row, rowIndex) => (
                  <View
                    key={rowIndex}
                    className={rowIndex === 0 ? "flex-row bg-subtle" : "flex-row"}
                  >
                    {row.map((cell, columnIndex) => (
                      <View
                        key={columnIndex}
                        className="w-48 border-r border-b border-border px-3 py-2"
                      >
                        <Text
                          selectable
                          className={
                            rowIndex === 0
                              ? "text-sm font-t3-semibold text-foreground"
                              : "text-sm text-foreground"
                          }
                        >
                          {cell}
                        </Text>
                      </View>
                    ))}
                  </View>
                ))}
              </View>
            </ScrollView>
          </ScrollView>
        ) : document.activeMode === "markdown" && props.environmentId ? (
          <FileMarkdownPreview
            cwd=""
            relativePath=""
            environmentId={props.environmentId}
            threadId={null}
            markdown={content.text}
            captured
          />
        ) : (
          <SourceFileSurface contents={content.text} path={props.name} selectable />
        )}
      </View>
    );
  }
  if (document.kind === "audio") {
    return <AudioFilePreview key={document.revision} uri={document.uri} onRetry={document.retry} />;
  }
  if (document.kind === "html") {
    return <WorkspaceFileWebPreview uri={document.uri} />;
  }
  return (
    <View className="flex-1 items-center justify-center bg-sheet px-6">
      <EmptyState
        title="No preview for this file"
        detail={
          props.nativeError ??
          "No app on this device can show this format. Save or share it to open it elsewhere."
        }
        actionLabel="Try again"
        onAction={props.onOpenNative}
      />
    </View>
  );
}

export function AttachmentFileScreen(props: AttachmentFileScreenProps) {
  const navigation = useNavigation();
  const { appearance, setCodeWordBreak } = useAppearancePreferences();
  const iconColor = useUniwindTheme()["--color-icon"];
  const isAndroid = Platform.OS === "android";
  const params = props.route.params;
  const environmentId = params.environmentId ? EnvironmentId.make(params.environmentId) : null;
  const sizeBytes = Number.parseInt(params.sizeBytes, 10) || 0;
  const draftKey = params.draftKey ?? null;
  const draft = useComposerDraft(draftKey);
  const draftAttachment = draftKey
    ? draft.attachments.find((entry) => entry.id === params.attachmentId)
    : undefined;
  const localAttachment =
    draftAttachment && isFileBackedComposerAttachment(draftAttachment) ? draftAttachment : null;
  const document = useAttachmentDocument({
    name: params.name,
    mimeType: params.mimeType,
    sizeBytes,
    attachmentId: params.attachmentId,
    environmentId,
    attachment: localAttachment,
  });
  const [nativeOpen, setNativeOpen] = useState(false);
  // A format we cannot render goes straight to the system viewer; this screen is only the
  // launch pad and, when no viewer can show it, the honest fallback.
  const nativeKind = nativeViewerKind(document.kind);
  const [nativeViewer, setNativeViewer] = useState<"pending" | "open" | "unavailable" | null>(
    nativeKind ? "pending" : null,
  );
  const [nativeError, setNativeError] = useState<string | null>(null);
  const pendingNativeError = useRef<string | null>(null);
  const handleBack = useCallback(() => {
    if (navigation.canGoBack()) navigation.goBack();
  }, [navigation]);
  const { uri, resource } = document;
  useEffect(() => {
    if (nativeViewer !== "pending" || !uri) return;
    // oxlint-disable-next-line react/set-state-in-effect -- Presenting the viewer waits on the resolved file.
    setNativeViewer("open");
    setNativeOpen(true);
  }, [nativeViewer, uri]);
  // The viewer mints its own fresh URL from the resource, so a link that expired while this
  // screen sat in the background is never handed to Quick Look or ACTION_VIEW.
  const nativeSource = useMemo<FilePreviewSource | null>(() => {
    const kind = nativeKind ?? "document";
    const base = { kind, name: params.name, mimeType: params.mimeType };
    if (localAttachment) return { ...base, attachment: localAttachment };
    if (environmentId) return { ...base, environmentId, resource };
    return uri ? { ...base, uri } : null;
  }, [environmentId, localAttachment, nativeKind, params.mimeType, params.name, resource, uri]);
  const handleNativeOpenError = useCallback((error: unknown) => {
    pendingNativeError.current = nativeViewerErrorMessage(error);
  }, []);
  const handleNativeClose = useCallback(() => {
    setNativeOpen(false);
    const message = pendingNativeError.current;
    pendingNativeError.current = null;
    if (nativeViewer === null) {
      // A file this screen renders itself: an explicit viewer failure is worth a word.
      if (message) Alert.alert("Could not open document", message);
      return;
    }
    if (message) {
      setNativeError(message);
      setNativeViewer("unavailable");
      return;
    }
    // The viewer was the whole visit: return to the conversation rather than a blank screen.
    handleBack();
  }, [handleBack, nativeViewer]);
  const removeFromDraft = useCallback(() => {
    if (!draftKey) return;
    removeComposerDraftAttachment(draftKey, params.attachmentId);
    handleBack();
  }, [draftKey, handleBack, params.attachmentId]);

  const { content, renderedMode, activeMode, setRendered, share, sharing } = document;
  const menuActions = useMemo(
    () =>
      [
        renderedMode
          ? ({
              id: "preview",
              title: renderedMode === "table" ? "Table" : "Preview",
              icon: renderedMode === "table" ? "tablecells" : "eye",
              inline: true,
              onPress: () => setRendered(true),
            } as const)
          : null,
        renderedMode
          ? ({
              id: "source",
              title: "Source",
              icon: "doc.text",
              inline: true,
              onPress: () => setRendered(false),
            } as const)
          : null,
        content && activeMode === "source"
          ? ({
              id: "word-wrap",
              title: appearance.codeWordBreak ? "Disable word wrap" : "Enable word wrap",
              icon: "text.alignleft",
              inline: false,
              onPress: () => setCodeWordBreak(!appearance.codeWordBreak),
            } as const)
          : null,
        content
          ? ({
              id: "copy",
              title: content.truncated ? "Copy preview" : "Copy contents",
              icon: "doc.on.doc",
              inline: false,
              onPress: () => copyTextWithHaptic(content.text),
            } as const)
          : null,
        uri
          ? ({
              id: "share",
              title: sharing ? "Opening share sheet…" : "Save or share",
              icon: "square.and.arrow.up",
              inline: false,
              onPress: () => void share(),
            } as const)
          : null,
        uri
          ? ({
              id: "open-viewer",
              title: "Open in file viewer",
              icon: "arrow.up.left.and.arrow.down.right",
              inline: false,
              onPress: () => {
                setNativeViewer((current) => (current === null ? null : "open"));
                setNativeOpen(true);
              },
            } as const)
          : null,
        draftKey
          ? ({
              id: "remove",
              title: "Remove from draft",
              icon: "trash",
              inline: false,
              destructive: true,
              onPress: removeFromDraft,
            } as const)
          : null,
      ].filter((action) => action !== null),
    [
      appearance.codeWordBreak,
      setCodeWordBreak,
      content,
      draftKey,
      removeFromDraft,
      activeMode,
      renderedMode,
      setRendered,
      share,
      sharing,
      uri,
    ],
  );
  const selectedAction = activeMode === "source" ? "source" : "preview";
  const androidMenuActions = useMemo<MenuAction[]>(
    () =>
      menuActions.map((action) => ({
        id: action.id,
        title: action.title,
        image: action.icon,
        state: action.inline ? (action.id === selectedAction ? "on" : "off") : undefined,
        ...("destructive" in action ? { attributes: { destructive: true } } : {}),
      })),
    [selectedAction, menuActions],
  );
  const handleAndroidMenuAction = useCallback(
    (event: { nativeEvent: { event: string } }) => {
      menuActions.find(({ id }) => id === event.nativeEvent.event)?.onPress();
    },
    [menuActions],
  );
  const subtitle = `${draftKey ? "Draft attachment" : "Attachment"} · ${formatAttachmentSize(sizeBytes)}`;

  return (
    <View className="flex-1 bg-sheet">
      <NativeStackScreenOptions
        options={{
          headerShown: !isAndroid,
          headerTintColor: iconColor,
          headerTitle: params.name,
          title: params.name,
          unstable_headerSubtitle: Platform.OS === "ios" ? subtitle : undefined,
        }}
      />
      {isAndroid ? (
        <AndroidScreenHeader
          title={params.name}
          subtitle={subtitle}
          onBack={handleBack}
          trailing={
            <ControlPillMenu
              actions={androidMenuActions}
              isAnchoredToRight
              title="File actions"
              onPressAction={handleAndroidMenuAction}
            >
              <AndroidHeaderIconButton accessibilityLabel="File actions" icon="ellipsis" />
            </ControlPillMenu>
          }
        />
      ) : null}
      <NativeHeaderToolbar placement="right">
        <NativeHeaderToolbar.Menu accessibilityLabel="File actions" icon="ellipsis">
          {renderedMode ? (
            <NativeHeaderToolbar.Menu inline>
              {menuActions
                .filter(({ inline }) => inline)
                .map((action) => (
                  <NativeHeaderToolbar.MenuAction
                    key={action.id}
                    icon={action.icon}
                    isOn={action.id === selectedAction}
                    onPress={action.onPress}
                  >
                    {action.title}
                  </NativeHeaderToolbar.MenuAction>
                ))}
            </NativeHeaderToolbar.Menu>
          ) : null}
          {menuActions
            .filter(({ inline }) => !inline)
            .map((action) => (
              <NativeHeaderToolbar.MenuAction
                key={action.id}
                icon={action.icon}
                destructive={"destructive" in action}
                onPress={action.onPress}
              >
                {action.title}
              </NativeHeaderToolbar.MenuAction>
            ))}
        </NativeHeaderToolbar.Menu>
      </NativeHeaderToolbar>
      <AttachmentDocumentBody
        document={document}
        name={params.name}
        environmentId={environmentId}
        nativeViewer={nativeViewer}
        nativeError={nativeError}
        onOpenNative={() => {
          setNativeViewer((current) => (current === null ? null : "open"));
          setNativeOpen(true);
        }}
      />
      {nativeOpen && nativeSource ? (
        <FilePreviewModal
          source={nativeSource}
          onRequestClose={handleNativeClose}
          onOpenError={handleNativeOpenError}
        />
      ) : null}
    </View>
  );
}
