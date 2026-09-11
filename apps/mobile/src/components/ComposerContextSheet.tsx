import type {
  ComposerContextRecord,
  ElementContextSource,
  EnvironmentId,
} from "@t3tools/contracts";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { videoMimeType } from "@t3tools/shared/video";
import { useState } from "react";
import {
  Alert,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { REVIEW_MONO_FONT_FAMILY } from "../features/review/reviewDiffRendering";
import { ReviewCommentCard, useReviewCommentColors } from "../features/review/ReviewCommentCard";
import {
  composerAttachmentInlineUri,
  isFileBackedComposerAttachment,
  type DraftComposerAttachment,
} from "../lib/composerImages";
import { FilePreviewModal } from "./FilePreviewModal";
import { VideoPreviewModal } from "./VideoPreviewModal";
import { ComposerContextAttachment } from "./ComposerContextAttachment";
import { AppText as Text } from "./AppText";
import { SymbolView } from "./AppSymbol";
import { ContextSheetSize } from "./ContextSheetSize";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { getMobileTerminalTheme } from "../features/terminal/terminalTheme";

function ContextField(props: { label: string; value: string | null | undefined; code?: boolean }) {
  if (!props.value) return null;
  return (
    <View className="gap-1">
      <Text className="text-xs text-foreground-muted">{props.label}</Text>
      <Text
        selectable
        className={props.code ? "text-sm text-foreground" : "text-base text-foreground"}
        style={props.code ? { fontFamily: REVIEW_MONO_FONT_FAMILY } : undefined}
      >
        {props.value}
      </Text>
    </View>
  );
}

function ContextSource(props: { source: ElementContextSource | null }) {
  const source = props.source;
  if (!source) return null;
  const location = source.fileName
    ? `${source.fileName}${source.lineNumber !== null ? `:${source.lineNumber}${source.columnNumber !== null ? `:${source.columnNumber}` : ""}` : ""}`
    : null;
  return (
    <ContextField
      label="Source"
      value={[source.functionName, location].filter(Boolean).join("\n")}
      code
    />
  );
}

/** Touch equivalent of the web context popover; snapshots remain readable offline. */
export function ComposerContextSheet(props: {
  readonly label: string;
  readonly record: ComposerContextRecord | undefined;
  readonly onClose: () => void;
  readonly onRemove?: () => void;
  readonly onOpenAttachment?: () => void;
  readonly onOpenPullRequest?: () => void;
  readonly environmentId?: EnvironmentId;
  readonly records?: ReadonlyArray<ComposerContextRecord>;
  readonly attachments?: ReadonlyArray<DraftComposerAttachment>;
}) {
  const reviewColors = useReviewCommentColors();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { themeId, themeAppearance } = useAppearancePreferences();
  const terminalTheme = getMobileTerminalTheme(themeId, themeAppearance);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [bodyHeight, setBodyHeight] = useState(0);
  const measuredHeight = headerHeight + bodyHeight;
  const record = props.record;
  const localAttachment =
    record && "attachmentId" in record
      ? props.attachments?.find((entry) => entry.id === record.attachmentId)
      : undefined;
  const localFile =
    localAttachment && isFileBackedComposerAttachment(localAttachment)
      ? localAttachment
      : undefined;
  if (record && !("payload" in record) && (record.kind === "image" || record.kind === "file")) {
    const mimeType = videoMimeType(record) ?? record.mimeType;
    const resource = {
      _tag: "attachment" as const,
      attachmentId: record.attachmentId,
      fileName: record.name,
      mimeType,
    };
    const remoteSource = props.environmentId
      ? { environmentId: props.environmentId, resource }
      : null;
    if (videoMimeType(record)) {
      if (localFile?.type === "file") {
        return (
          <VideoPreviewModal
            source={{ type: "local", attachment: localFile }}
            onRequestClose={props.onClose}
          />
        );
      }
      if (remoteSource && !localFile) {
        return (
          <VideoPreviewModal
            source={{
              type: "media",
              name: record.name,
              mimeType,
              ...remoteSource,
              actionsSource: { name: record.name, mimeType, ...remoteSource },
            }}
            onRequestClose={props.onClose}
          />
        );
      }
    } else if (record.kind === "image" || mimeType === "application/pdf") {
      const inlineUri = composerAttachmentInlineUri(localAttachment);
      const source = localFile
        ? { attachment: localFile }
        : inlineUri
          ? { uri: inlineUri }
          : remoteSource;
      if (source) {
        return (
          <FilePreviewModal
            source={{
              kind: record.kind === "image" ? "image" : "pdf",
              name: record.name,
              ...source,
              actionsSource: { name: record.name, mimeType, ...source },
            }}
            onRequestClose={props.onClose}
          />
        );
      }
    }
  }
  const attachmentRecord =
    record && "attachmentId" in record
      ? record
      : record?.kind === "preview-annotation" && "screenshotContextId" in record
        ? props.records?.find(
            (entry) => entry.contextId === record.screenshotContextId && "attachmentId" in entry,
          )
        : undefined;
  const pullRequestUrl =
    record?.kind === "review-comment" && "pullRequest" in record
      ? record.pullRequest?.url
      : undefined;
  const terminal = record?.kind === "terminal" && !("payload" in record) ? record : null;
  return (
    <Modal
      animationType="slide"
      presentationStyle="pageSheet"
      transparent={Platform.OS === "android"}
      onRequestClose={props.onClose}
    >
      <View
        style={{
          flex: 1,
          justifyContent: "flex-end",
          backgroundColor: Platform.OS === "android" ? "#00000066" : undefined,
        }}
      >
        {Platform.OS === "android" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss context"
            onPress={props.onClose}
            style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
          />
        ) : null}
        <View
          className="overflow-hidden rounded-t-3xl bg-sheet-solid"
          style={
            Platform.OS === "android"
              ? {
                  height: Math.min(
                    measuredHeight || windowHeight * 0.5,
                    windowHeight - insets.top - 24,
                  ),
                }
              : { flex: 1 }
          }
        >
          <ContextSheetSize height={measuredHeight} />
          <View
            onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}
            className="flex-row items-center justify-between gap-3 border-b border-border px-4 pb-2 pt-4"
          >
            {terminal ? (
              <SymbolView name="terminal" size={20} tintColor={terminalTheme.palette[2]} />
            ) : null}
            <View className="min-w-0 flex-1">
              <Text className="text-base font-t3-semibold text-foreground" numberOfLines={2}>
                {terminal?.terminalLabel ?? props.label}
              </Text>
              {terminal ? (
                <Text className="text-xs text-foreground-muted">
                  Lines {terminal.lineStart}–{terminal.lineEnd}
                </Text>
              ) : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close context"
              onPress={props.onClose}
              className="p-3"
            >
              <Text className="text-foreground">Done</Text>
            </Pressable>
          </View>
          <ScrollView
            style={{ flexShrink: 1 }}
            onContentSizeChange={(_width, height) => setBodyHeight(height)}
            contentContainerStyle={{
              padding: 16,
              gap: 16,
              paddingBottom: Math.max(20, insets.bottom),
            }}
          >
            {!record ? (
              <Text className="text-foreground">
                Context unavailable. The reference was copied without its payload. Copy it again
                from the original message or remove it.
              </Text>
            ) : "payload" in record ? (
              <Text className="text-foreground">
                This context type is not supported by this version of the app. Its payload will be
                preserved when sent.
              </Text>
            ) : (
              <>
                {record.kind === "terminal" ? (
                  <View
                    className="overflow-hidden rounded-xl border border-border"
                    style={{ backgroundColor: terminalTheme.background }}
                  >
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator
                      contentContainerStyle={{ padding: 12 }}
                    >
                      <Text
                        selectable
                        className="text-sm text-foreground"
                        style={{
                          fontFamily: REVIEW_MONO_FONT_FAMILY,
                          fontSize: 13,
                          lineHeight: 20,
                        }}
                      >
                        {record.text}
                      </Text>
                    </ScrollView>
                  </View>
                ) : null}
                {record.kind === "review-comment" ? (
                  <>
                    {record.pullRequest ? (
                      <ContextField
                        label={`#${record.pullRequest.number} · ${record.pullRequest.isDraft ? "draft" : record.pullRequest.state}`}
                        value={`${record.pullRequest.title}\n${record.pullRequest.headBranch} → ${record.pullRequest.baseBranch}`}
                      />
                    ) : null}
                    {!record.sectionId.startsWith("pull-request:") ? (
                      <>
                        <ReviewCommentCard
                          comment={{ ...record, id: record.contextId }}
                          colors={reviewColors}
                        />
                      </>
                    ) : null}
                  </>
                ) : null}
                {record.kind === "preview-annotation" ? (
                  <>
                    <ContextField label="Page" value={record.pageTitle ?? record.pageUrl} />
                    <ContextField label="URL" value={record.pageUrl} />
                    <ContextField label="Comment" value={record.comment} />
                    <ContextField label="Selection" value={record.targetSummary} />
                    <ContextField
                      label="Requested changes"
                      value={record.styleChanges.join("\n")}
                    />
                    {record.elements?.map((element, index) => (
                      <View
                        key={`${element.selector ?? element.tagName}:${index}`}
                        className="gap-3"
                      >
                        <ContextField
                          label="Element"
                          value={element.componentName ?? element.tagName}
                        />
                        <ContextField label="Selector" value={element.selector} code />
                        <ContextSource source={element.source} />
                        <ContextField label="HTML" value={element.htmlPreview} code />
                        <ContextField label="Styles" value={element.styles} code />
                      </View>
                    ))}
                  </>
                ) : null}
                {record.kind === "element" ? (
                  <>
                    <ContextField label="Page" value={record.pageUrl} />
                    <ContextField label="Element" value={record.componentName ?? record.tagName} />
                    <ContextField label="Selector" value={record.selector} code />
                    <ContextSource source={record.source} />
                    <ContextField label="HTML" value={record.htmlPreview} code />
                    <ContextField label="Styles" value={record.styles} code />
                  </>
                ) : null}
                {record.kind === "image" || record.kind === "file" ? (
                  <ContextField
                    label="File"
                    value={`${record.mimeType} · ${formatAttachmentSize(record.sizeBytes)}`}
                  />
                ) : null}
                {record.kind === "mention" ? (
                  <ContextField label="Path" value={record.path} code />
                ) : null}
                {record.kind === "skill" ? (
                  <ContextField label="Skill" value={record.name} />
                ) : null}
              </>
            )}
            {attachmentRecord && "attachmentId" in attachmentRecord ? (
              <ComposerContextAttachment
                key={JSON.stringify([
                  props.environmentId,
                  attachmentRecord.attachmentId,
                  props.attachments?.find((entry) => entry.id === attachmentRecord.attachmentId)
                    ?.fileUri,
                ])}
                record={attachmentRecord}
                environmentId={props.environmentId}
                attachment={props.attachments?.find(
                  (entry) => entry.id === attachmentRecord.attachmentId,
                )}
              />
            ) : null}
            {pullRequestUrl && /^https?:\/\//i.test(pullRequestUrl) ? (
              <Pressable
                accessibilityRole="link"
                onPress={() => {
                  void Linking.openURL(pullRequestUrl).catch(() =>
                    Alert.alert("Could not open pull request", "Try again when connected."),
                  );
                }}
                className="rounded-xl bg-subtle p-4"
              >
                <Text className="text-foreground">Open pull request</Text>
              </Pressable>
            ) : null}
            {props.onOpenAttachment ? (
              <Pressable
                accessibilityRole="button"
                onPress={props.onOpenAttachment}
                className="rounded-xl bg-subtle p-4"
              >
                <Text className="text-foreground">Open attachment</Text>
              </Pressable>
            ) : null}
            {props.onOpenPullRequest ? (
              <Pressable
                accessibilityRole="button"
                onPress={props.onOpenPullRequest}
                className="rounded-xl bg-subtle p-4"
              >
                <Text className="text-foreground">Open pull request</Text>
              </Pressable>
            ) : null}
            {props.onRemove ? (
              <Pressable
                accessibilityRole="button"
                onPress={props.onRemove}
                className="rounded-xl bg-subtle p-4"
              >
                <Text className="text-foreground">Remove from draft</Text>
              </Pressable>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
