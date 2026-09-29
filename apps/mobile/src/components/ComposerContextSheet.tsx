import { translate } from "@t3tools/i18n";
import { SourceFileSurface } from "../features/files/SourceFileSurface";
import { filePreviewKind } from "@t3tools/shared/filePreview";
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
import { useTranslation } from "@t3tools/i18n/react";
import { REVIEW_MONO_FONT_FAMILY } from "../features/review/reviewDiffRendering";
import { pullRequestStateLabel } from "../features/threads/pullRequestStateLabel";
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
      {props.code && (props.label === "HTML" || props.label === "Styles") ? (
        <View
          className="overflow-hidden rounded-xl border border-border"
          style={{ height: Math.min(260, Math.max(100, props.value.split("\n").length * 22 + 36)) }}
        >
          <SourceFileSurface
            contents={props.value}
            path={props.label === "HTML" ? "element.html" : "styles.css"}
          />
        </View>
      ) : (
        <Text
          selectable
          className={props.code ? "text-sm text-foreground" : "text-base text-foreground"}
          style={props.code ? { fontFamily: REVIEW_MONO_FONT_FAMILY } : undefined}
        >
          {props.value}
        </Text>
      )}
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
      label={translate("common:mobileSource", "Source")}
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
  readonly skillDescription?: string;
  readonly onOpenSkill?: () => void;
  readonly environmentId?: EnvironmentId;
  readonly records?: ReadonlyArray<ComposerContextRecord>;
  readonly attachments?: ReadonlyArray<DraftComposerAttachment>;
}) {
  const { t } = useTranslation();
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
    const previewKind = filePreviewKind(record);
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
    } else if (record.kind === "image" || previewKind === "image" || previewKind === "pdf") {
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
              kind: record.kind === "image" || previewKind === "image" ? "image" : "pdf",
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
      presentationStyle={Platform.OS === "android" ? "overFullScreen" : "pageSheet"}
      transparent={Platform.OS === "android"}
      onRequestClose={props.onClose}
    >
      <View
        className={
          Platform.OS === "android" ? "flex-1 justify-end bg-backdrop" : "flex-1 justify-end"
        }
      >
        {Platform.OS === "android" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={translate("common:mobileDismissContext", "Dismiss context")}
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
                  {translate("common:mobileLinesRange", "Lines {{start}}–{{end}}", {
                    start: terminal.lineStart,
                    end: terminal.lineEnd,
                  })}
                </Text>
              ) : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={translate("common:mobileCloseContext", "Close context")}
              onPress={props.onClose}
              className="p-3"
            >
              <Text className="text-foreground">{t("done")}</Text>
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
                {translate(
                  "common:mobileContextPayloadUnavailable",
                  "Context unavailable. The reference was copied without its payload. Copy it again from the original message or remove it.",
                )}
              </Text>
            ) : "payload" in record ? (
              <Text className="text-foreground">
                {translate(
                  "common:mobileUnsupportedContextType",
                  "This context type is not supported by this version of the app. Its payload will be preserved when sent.",
                )}
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
                        label={translate(
                          "common:mobileUiPullRequestContextLabel",
                          "#{{number}} · {{state}}",
                          {
                            number: record.pullRequest.number,
                            state: record.pullRequest.isDraft
                              ? translate("common:mobileUiDraft", "Draft")
                              : pullRequestStateLabel(record.pullRequest.state),
                          },
                        )}
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
                    <ContextField
                      label={translate("common:mobilePage", "Page")}
                      value={record.pageTitle ?? record.pageUrl}
                    />
                    <ContextField
                      label={translate("common:mobileUrlField", "URL")}
                      value={record.pageUrl}
                    />
                    <ContextField
                      label={translate("common:comment", "Comment")}
                      value={record.comment}
                    />
                    <ContextField
                      label={translate("common:mobileSelection", "Selection")}
                      value={record.targetSummary}
                    />
                    <ContextField
                      label={translate("common:mobileRequestedChanges", "Requested changes")}
                      value={record.styleChanges.join("\n")}
                    />
                    {record.elements?.map((element, index) => (
                      <View
                        key={`${element.selector ?? element.tagName}:${index}`}
                        className="gap-3"
                      >
                        <ContextField
                          label={translate("common:mobileElement", "Element")}
                          value={element.componentName ?? element.tagName}
                        />
                        <ContextField
                          label={translate("common:mobileSelector", "Selector")}
                          value={element.selector}
                          code
                        />
                        <ContextSource source={element.source} />
                        <ContextField
                          label={translate("common:mobileHTML", "HTML")}
                          value={element.htmlPreview}
                          code
                        />
                        <ContextField
                          label={translate("common:mobileStyles", "Styles")}
                          value={element.styles}
                          code
                        />
                      </View>
                    ))}
                  </>
                ) : null}
                {record.kind === "element" ? (
                  <>
                    <ContextField
                      label={translate("common:mobilePage", "Page")}
                      value={record.pageUrl}
                    />
                    <ContextField
                      label={translate("common:mobileElement", "Element")}
                      value={record.componentName ?? record.tagName}
                    />
                    <ContextField
                      label={translate("common:mobileSelector", "Selector")}
                      value={record.selector}
                      code
                    />
                    <ContextSource source={record.source} />
                    <ContextField
                      label={translate("common:mobileHTML", "HTML")}
                      value={record.htmlPreview}
                      code
                    />
                    <ContextField
                      label={translate("common:mobileStyles", "Styles")}
                      value={record.styles}
                      code
                    />
                  </>
                ) : null}
                {record.kind === "image" ? (
                  <ContextField
                    label={translate("common:attachmentFile", "File")}
                    value={`${record.mimeType} · ${formatAttachmentSize(record.sizeBytes)}`}
                  />
                ) : null}
                {record.kind === "mention" ? (
                  <ContextField
                    label={translate("chatView:worktreePath", "Path")}
                    value={record.path}
                    code
                  />
                ) : null}
                {record.kind === "skill" ? (
                  <View className="gap-3">
                    <ContextField
                      label={translate("common:mobileSkill", "Skill")}
                      value={record.name}
                    />
                    <ContextField
                      label={translate("pullRequests:description", "Description")}
                      value={
                        props.skillDescription ??
                        translate(
                          "common:mobileComposer.noSkillDescription",
                          "No description is available for this skill.",
                        )
                      }
                    />
                    {props.onOpenSkill ? (
                      <Pressable
                        accessibilityRole="button"
                        onPress={props.onOpenSkill}
                        className="rounded-xl bg-subtle p-4"
                      >
                        <Text className="text-foreground">{t("viewInstructions")}</Text>
                      </Pressable>
                    ) : null}
                  </View>
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
                    Alert.alert(
                      translate(
                        "common:mobileComposer.couldNotOpenPullRequest",
                        "Could not open pull request",
                      ),
                      translate(
                        "common:mobileComposer.tryAgainWhenConnected",
                        "Try again when connected.",
                      ),
                    ),
                  );
                }}
                className="rounded-xl bg-subtle p-4"
              >
                <Text className="text-foreground">{t("openPullRequest")}</Text>
              </Pressable>
            ) : null}
            {props.onOpenAttachment ? (
              <Pressable
                accessibilityRole="button"
                onPress={props.onOpenAttachment}
                className="rounded-xl bg-subtle p-4"
              >
                <Text className="text-foreground">{t("openAttachment")}</Text>
              </Pressable>
            ) : null}
            {props.onOpenPullRequest ? (
              <Pressable
                accessibilityRole="button"
                onPress={props.onOpenPullRequest}
                className="rounded-xl bg-subtle p-4"
              >
                <Text className="text-foreground">{t("openPullRequest")}</Text>
              </Pressable>
            ) : null}
            {props.onRemove ? (
              <Pressable
                accessibilityRole="button"
                onPress={props.onRemove}
                className="rounded-xl bg-subtle p-4"
              >
                <Text className="text-foreground">{t("removeFromDraft")}</Text>
              </Pressable>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
