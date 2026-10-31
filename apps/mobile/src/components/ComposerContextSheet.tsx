import { Button } from "./ui/Button";
import * as Dialog from "./ui/Dialog";
import { useOpenPullRequest } from "../native/useOpenPullRequest";
import { SourceFileSurface } from "../features/files/SourceFileSurface";
import { filePreviewKind } from "@t3tools/shared/filePreview";
import type {
  ComposerContextRecord,
  ElementContextSource,
  EnvironmentId,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { videoMimeType } from "@t3tools/shared/video";
import type { LinearIssueContextRecord } from "@t3tools/contracts";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { REVIEW_MONO_FONT_FAMILY } from "../features/review/reviewDiffRendering";
import { ReviewCommentCard, useReviewCommentColors } from "../features/review/ReviewCommentCard";
import {
  composerAttachmentInlineUri,
  isFileBackedComposerAttachment,
  type DraftComposerAttachment,
} from "../lib/composerImages";
import { contextImageGallery } from "../lib/contextImageGallery";
import { tryOpenWebLink } from "../lib/openExternalUrl";
import { FilePreviewModal } from "./ui/FilePreviewModal";
import { VideoPreviewModal } from "./ui/VideoPreviewModal";
import { ComposerContextAttachment } from "./ComposerContextAttachment";
import { AppText as Text } from "./ui/AppText";
import { Sheet } from "./ui/Sheet";
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
            embedded
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
      label="Source"
      value={[source.functionName, location].filter(Boolean).join("\n")}
      code
    />
  );
}

function LinearIssueSnapshot(props: { readonly record: LinearIssueContextRecord }) {
  const { record } = props;
  const breadcrumb = [record.teamName, record.projectName, record.milestoneName].filter(
    (part): part is string => part !== null && part.length > 0,
  );
  const meta = [record.stateName, record.priorityLabel, record.assigneeName].filter(
    (part): part is string => part !== null && part.length > 0,
  );
  const excerpt = record.description.trim().slice(0, 600);
  return (
    <View className="gap-4">
      <ContextField label={breadcrumb.join(" › ")} value={`${record.identifier} ${record.title}`} />
      <ContextField label="Status" value={meta.join(" · ")} />
      <ContextField label="Labels" value={record.labels.join(", ")} />
      <ContextField
        label="Description"
        value={excerpt.length < record.description.trim().length ? `${excerpt}…` : excerpt}
      />
      {record.subIssues.length > 0 ? (
        <ContextField
          label={`Sub-issues (${record.subIssues.length})`}
          value={record.subIssues
            .slice(0, 5)
            .map((sub) => `${sub.identifier} ${sub.title}`)
            .concat(record.subIssues.length > 5 ? [`and ${record.subIssues.length - 5} more`] : [])
            .join("\n")}
        />
      ) : null}
      {record.comments.length > 0 ? (
        <ContextField
          label={`Comments (${record.comments.length})`}
          value={record.comments
            .slice(-2)
            .map(
              (comment) => `${comment.author ?? "Unknown"}: ${comment.body.trim().slice(0, 200)}`,
            )
            .join("\n")}
        />
      ) : null}
      <Text className="text-xs text-foreground-muted">
        Snapshot taken when attached; later edits in Linear are not included.
      </Text>
      {/^https?:\/\//i.test(record.url) ? (
        <Button
          label="Open in Linear"
          tone="secondary"
          onPress={() => void tryOpenWebLink(record.url, "markdown-link")}
          fullWidth
        />
      ) : null}
    </View>
  );
}

export function ComposerContextSheet(props: {
  readonly label: string;
  readonly record: ComposerContextRecord | undefined;
  readonly onClose: () => void;
  readonly onRemove?: () => void;
  readonly onOpenAttachment?: () => void;
  readonly onOpenPullRequest?: () => void;
  readonly skillDescription?: string;
  readonly onOpenSkill?: () => void;
  readonly onOpenThread?: (thread: ScopedThreadRef) => void;
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
  readonly records?: ReadonlyArray<ComposerContextRecord>;
  readonly attachments?: ReadonlyArray<DraftComposerAttachment>;
}) {
  const openPullRequest = useOpenPullRequest({
    context:
      props.environmentId && props.projectId
        ? { environmentId: props.environmentId, projectId: props.projectId }
        : undefined,
  });
  const reviewColors = useReviewCommentColors();
  const insets = useSafeAreaInsets();
  const { themeId, themeAppearance } = useAppearancePreferences();
  const terminalTheme = getMobileTerminalTheme(themeId, themeAppearance);
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
    const previewKind = filePreviewKind(record, { richDocuments: false });
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
              gallery: contextImageGallery(
                props.records ?? [],
                props.attachments ?? [],
                props.environmentId,
              ),
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
  const changeRequestTerm = (
    (pullRequestUrl ? sourceControlClients.findByChangeRequestUrl(pullRequestUrl) : undefined) ??
    sourceControlClients.get(undefined)
  ).changeRequest.singular;
  const terminal = record?.kind === "terminal" && !("payload" in record) ? record : null;
  return (
    <Sheet title={terminal?.terminalLabel ?? props.label} onClose={props.onClose}>
      <ScrollView
        nestedScrollEnabled
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 12,
          gap: 16,
          paddingBottom: Math.max(20, insets.bottom),
        }}
      >
        {terminal ? (
          <Text className="text-sm text-foreground-muted">
            Lines {terminal.lineStart}–{terminal.lineEnd}
          </Text>
        ) : null}
        {!record ? (
          <Text className="text-foreground">
            Context unavailable. The reference was copied without its payload. Copy it again from
            the original message or remove it.
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
                className="overflow-hidden rounded-xl"
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
                      color: terminalTheme.foreground,
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
                <ContextField label="Requested changes" value={record.styleChanges.join("\n")} />
                {record.elements?.map(
                  (element, index) => (
                    /* oxlint-disable react/no-array-index-key -- Captured DOM elements are a fixed snapshot without persistent element IDs. */ <View
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
                  ) /* oxlint-enable react/no-array-index-key */,
                )}
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
            {record.kind === "image" ? (
              <ContextField
                label="File"
                value={`${record.mimeType} · ${formatAttachmentSize(record.sizeBytes)}`}
              />
            ) : null}
            {record.kind === "mention" ? (
              <ContextField label="Path" value={record.path} code />
            ) : null}
            {record.kind === "thread" ? (
              <View className="gap-3">
                <ContextField label="Thread" value={record.title} />
                {props.onOpenThread ? (
                  <Button
                    label="Open thread"
                    tone="secondary"
                    onPress={() =>
                      props.onOpenThread?.({
                        environmentId: record.environmentId,
                        threadId: record.threadId,
                      })
                    }
                    fullWidth
                  />
                ) : null}
              </View>
            ) : null}
            {record.kind === "linear-issue" ? <LinearIssueSnapshot record={record} /> : null}
            {record.kind === "environment" ? (
              <ContextField label="Machine" value={record.label} />
            ) : null}
            {record.kind === "skill" ? (
              <View className="gap-3">
                <ContextField label="Skill" value={record.name} />
                <ContextField
                  label="Description"
                  value={props.skillDescription ?? "No description is available for this skill."}
                />
                {props.onOpenSkill ? (
                  <Button
                    label="View instructions"
                    tone="secondary"
                    onPress={props.onOpenSkill}
                    fullWidth
                  />
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
              props.onClose();
              void openPullRequest(pullRequestUrl).catch(() =>
                Dialog.alert(`Could not open ${changeRequestTerm}`, "Try again when connected."),
              );
            }}
            className="rounded-xl bg-subtle p-4"
          >
            <Text className="text-foreground">Open {changeRequestTerm}</Text>
          </Pressable>
        ) : null}
        {props.onOpenAttachment ? (
          <Button
            label="Open attachment"
            tone="secondary"
            onPress={props.onOpenAttachment}
            fullWidth
          />
        ) : null}
        {props.onOpenPullRequest && !pullRequestUrl ? (
          <Button
            label={`Open ${changeRequestTerm}`}
            tone="secondary"
            onPress={props.onOpenPullRequest}
            fullWidth
          />
        ) : null}
        {props.onRemove ? (
          <Button label="Remove from draft" tone="secondary" onPress={props.onRemove} fullWidth />
        ) : null}
      </ScrollView>
    </Sheet>
  );
}
