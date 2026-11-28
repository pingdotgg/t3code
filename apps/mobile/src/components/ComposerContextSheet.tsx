import { T, useGT, useMessages, Var } from "gt-react-native";

import { Button } from "./ui/Button";
import * as Dialog from "./ui/Dialog";
import { useOpenPullRequest } from "../native/useOpenPullRequest";
import { SourceFileSurface } from "../features/files/SourceFileSurface";
import { filePreviewKind } from "@t3tools/shared/filePreview";
import type {
  ComposerContextRecord,
  ElementContextSource,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProjectKnowledgeContextRecord,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import {
  deliveredKnowledgeNotes,
  deliveredKnowledgeSnapshot,
  KNOWLEDGE_DELIVERY_OMISSION_LABEL,
} from "@t3tools/client-runtime/projectKnowledge";
import { projectKnowledge } from "../state/projectKnowledge";
import { useAtomValue } from "@effect/atom-react";
import { serverEnvironment } from "../state/server";
import { useEnvironmentQuery } from "../state/query";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { changeRequestTermKind } from "../lib/changeRequestTerm";
import { videoMimeType } from "@t3tools/shared/video";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ReviewCommentCard, useReviewCommentColors } from "../features/review/ReviewCommentCard";
import { reviewCommentRangeText } from "../features/review/reviewCommentSelection";
import {
  composerAttachmentInlineUri,
  isFileBackedComposerAttachment,
  type DraftComposerAttachment,
} from "../lib/composerImages";
import { contextImageGallery } from "../lib/contextImageGallery";
import { FilePreviewModal } from "./ui/FilePreviewModal";
import { VideoPreviewModal } from "./ui/VideoPreviewModal";
import { ComposerContextAttachment } from "./ComposerContextAttachment";
import { AppText as Text } from "./ui/AppText";
import { Sheet } from "./ui/Sheet";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { getMobileTerminalTheme } from "../features/terminal/terminalTheme";

function ContextField(props: {
  label: string;
  value: string | null | undefined;
  code?: boolean;
  language?: "html" | "css";
}) {
  if (!props.value) return null;
  return (
    <View className="gap-1">
      <Text className="text-xs text-foreground-muted">{props.label}</Text>
      {props.code && props.language ? (
        <View
          className="overflow-hidden rounded-xl border border-border"
          style={{ height: Math.min(260, Math.max(100, props.value.split("\n").length * 22 + 36)) }}
        >
          <SourceFileSurface
            embedded
            contents={props.value}
            path={props.language === "html" ? "element.html" : "styles.css"}
          />
        </View>
      ) : (
        <Text
          selectable
          className={props.code ? "font-mono text-sm text-foreground" : "text-base text-foreground"}
        >
          {props.value}
        </Text>
      )}
    </View>
  );
}

function ContextSource(props: { source: ElementContextSource | null }) {
  const gt = useGT();
  const source = props.source;
  if (!source) return null;
  const location = source.fileName
    ? `${source.fileName}${source.lineNumber !== null ? `:${source.lineNumber}${source.columnNumber !== null ? `:${source.columnNumber}` : ""}` : ""}`
    : null;
  return (
    <ContextField
      label={gt("Source", { $context: "where an element is defined in source code" })}
      value={[source.functionName, location].filter(Boolean).join("\n")}
      code
    />
  );
}

// Shows the recorded copy a sent message delivered, never a fresh read that may have changed.
function DeliveredProjectKnowledge(props: {
  readonly record: ProjectKnowledgeContextRecord;
  readonly sent: { readonly threadId: ThreadId; readonly messageId: MessageId };
}) {
  const gt = useGT();
  const m = useMessages();
  const config = useAtomValue(
    serverEnvironment.configValueAtom(props.record.knowledge.environmentId),
  );
  const supportsDeliveries = config?.environment?.capabilities.projectKnowledgeDeliveries === true;
  const query = useEnvironmentQuery(
    supportsDeliveries
      ? projectKnowledge.readDeliveries({
          environmentId: props.record.knowledge.environmentId,
          input: { projectId: props.record.knowledge.projectId, ...props.sent },
        })
      : null,
  );
  const snapshot = query.data
    ? deliveredKnowledgeSnapshot(query.data, props.record.contextId)
    : null;
  if (!supportsDeliveries)
    return (
      <Text className="text-sm text-foreground-muted">
        <T>This server can't show what was sent</T>
      </Text>
    );
  if (query.error) return <Text className="text-sm text-foreground-muted">{query.error}</Text>;
  if (query.data === null)
    return (
      <Text className="text-sm text-foreground-muted">
        <T>Reading delivery record…</T>
      </Text>
    );
  if (snapshot === null)
    return (
      <Text className="text-sm text-foreground-muted">
        <T>No delivery was recorded for this reference.</T>
      </Text>
    );
  return (
    <View className="gap-2">
      <Text className="text-sm text-foreground-muted">
        <T>The copy T3 delivered with this message. It does not show whether the agent used it.</T>
      </Text>
      {deliveredKnowledgeNotes(snapshot, m).map((note) => (
        <Text key={note} className="text-sm text-foreground-muted">
          {note}
        </Text>
      ))}
      {snapshot.omission ? (
        <Text className="text-sm text-foreground">
          {gt("Not sent: {reason}", {
            reason: m(KNOWLEDGE_DELIVERY_OMISSION_LABEL[snapshot.omission.reason]),
          })}
        </Text>
      ) : snapshot.item.contentRemoved ? null : (
        <ContextField label={gt("As sent")} value={snapshot.item.text} code />
      )}
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
  readonly sent?: { readonly threadId: ThreadId; readonly messageId: MessageId };
}) {
  const openPullRequest = useOpenPullRequest({
    context:
      props.environmentId && props.projectId
        ? { environmentId: props.environmentId, projectId: props.projectId }
        : undefined,
  });
  const gt = useGT();
  const messages = useMessages();
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
  const term = changeRequestTermKind(
    (
      (pullRequestUrl ? sourceControlClients.findByChangeRequestUrl(pullRequestUrl) : undefined) ??
      sourceControlClients.get(undefined)
    ).changeRequest,
  );
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
            <T>
              Lines <Var>{terminal.lineStart}</Var>–<Var>{terminal.lineEnd}</Var>
            </T>
          </Text>
        ) : null}
        {!record ? (
          <Text className="text-foreground">
            <T>
              Context unavailable. The reference was copied without its payload. Copy it again from
              the original message or remove it.
            </T>
          </Text>
        ) : "payload" in record ? (
          <Text className="text-foreground">
            <T>
              This context type is not supported by this version of the app. Its payload will be
              preserved when sent.
            </T>
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
                    className="font-mono text-sm text-foreground"
                    style={{
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
                    label={`#${record.pullRequest.number} · ${
                      record.pullRequest.isDraft
                        ? gt("draft", { $context: "pull request state" })
                        : record.pullRequest.state === "open"
                          ? gt("open", { $context: "pull request state" })
                          : record.pullRequest.state === "closed"
                            ? gt("closed", { $context: "pull request state" })
                            : gt("merged", { $context: "pull request state" })
                    }`}
                    value={`${record.pullRequest.title}\n${record.pullRequest.headBranch} → ${record.pullRequest.baseBranch}`}
                  />
                ) : null}
                {!record.sectionId.startsWith("pull-request:") ? (
                  <>
                    <ReviewCommentCard
                      comment={{
                        ...record,
                        id: record.contextId,
                        rangeLabel: reviewCommentRangeText(record.rangeLabel, messages),
                      }}
                      colors={reviewColors}
                    />
                  </>
                ) : null}
              </>
            ) : null}
            {record.kind === "preview-annotation" ? (
              <>
                <ContextField
                  label={gt("Page", { $context: "web page" })}
                  value={record.pageTitle ?? record.pageUrl}
                />
                <ContextField label={gt("URL")} value={record.pageUrl} />
                <ContextField label={gt("Comment", { $context: "noun" })} value={record.comment} />
                <ContextField
                  label={gt("Selection", { $context: "selected part of a web page" })}
                  value={record.targetSummary}
                />
                <ContextField
                  label={gt("Requested changes")}
                  value={record.styleChanges.join("\n")}
                />
                {record.elements?.map(
                  (element, index) => (
                    /* oxlint-disable react/no-array-index-key -- Captured DOM elements are a fixed snapshot without persistent element IDs. */ <View
                      key={`${element.selector ?? element.tagName}:${index}`}
                      className="gap-3"
                    >
                      <ContextField
                        label={gt("Element", { $context: "HTML element on a web page" })}
                        value={element.componentName ?? element.tagName}
                      />
                      <ContextField
                        label={gt("Selector", { $context: "CSS selector" })}
                        value={element.selector}
                        code
                      />
                      <ContextSource source={element.source} />
                      <ContextField
                        label={gt("HTML")}
                        value={element.htmlPreview}
                        code
                        language="html"
                      />
                      <ContextField
                        label={gt("Styles", { $context: "CSS styles" })}
                        value={element.styles}
                        code
                        language="css"
                      />
                    </View>
                  ) /* oxlint-enable react/no-array-index-key */,
                )}
              </>
            ) : null}
            {record.kind === "element" ? (
              <>
                <ContextField label={gt("Page", { $context: "web page" })} value={record.pageUrl} />
                <ContextField
                  label={gt("Element", { $context: "HTML element on a web page" })}
                  value={record.componentName ?? record.tagName}
                />
                <ContextField
                  label={gt("Selector", { $context: "CSS selector" })}
                  value={record.selector}
                  code
                />
                <ContextSource source={record.source} />
                <ContextField label={gt("HTML")} value={record.htmlPreview} code language="html" />
                <ContextField
                  label={gt("Styles", { $context: "CSS styles" })}
                  value={record.styles}
                  code
                  language="css"
                />
              </>
            ) : null}
            {record.kind === "image" ? (
              <ContextField
                label={gt("File", { $context: "noun" })}
                value={`${record.mimeType} · ${formatAttachmentSize(record.sizeBytes, messages)}`}
              />
            ) : null}
            {record.kind === "mention" ? (
              <ContextField
                label={gt("Path", { $context: "file path" })}
                value={record.path}
                code
              />
            ) : null}
            {record.kind === "thread" ? (
              <View className="gap-3">
                <ContextField label={gt("Thread", { $context: "noun" })} value={record.title} />
                {props.onOpenThread ? (
                  <Button
                    label={gt("Open thread")}
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
            {record.kind === "project-knowledge" ? (
              <View className="gap-2">
                <ContextField label={gt("Project")} value={record.knowledge.projectId} code />
                <ContextField
                  label={gt("Environment")}
                  value={record.knowledge.environmentId}
                  code
                />
                <ContextField
                  label={gt("Selected evidence")}
                  value={gt("{count, plural, one {{count} reference} other {{count} references}}", {
                    count: record.knowledge.selections.length,
                  })}
                />
                {props.sent && "knowledge" in record ? (
                  <DeliveredProjectKnowledge record={record} sent={props.sent} />
                ) : (
                  <Text className="text-sm text-foreground-muted">
                    <T>The current evidence is loaded when this message is sent.</T>
                  </Text>
                )}
              </View>
            ) : null}
            {record.kind === "environment" ? (
              <ContextField label={gt("Machine", { $context: "computer" })} value={record.label} />
            ) : null}
            {record.kind === "skill" ? (
              <View className="gap-3">
                <ContextField
                  label={gt("Skill", { $context: "agent skill" })}
                  value={record.name}
                />
                <ContextField
                  label={gt("Description")}
                  value={
                    props.skillDescription ?? gt("No description is available for this skill.")
                  }
                />
                {props.onOpenSkill ? (
                  <Button
                    label={gt("View instructions")}
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
                Dialog.alert(
                  gt(
                    "Could not open {term, select, mr {merge request} cr {change request} other {pull request}}",
                    { term },
                  ),
                  gt("Try again when connected."),
                ),
              );
            }}
            className="rounded-xl bg-subtle p-4"
          >
            <Text className="text-foreground">
              {gt(
                "Open {term, select, mr {merge request} cr {change request} other {pull request}}",
                { term },
              )}
            </Text>
          </Pressable>
        ) : null}
        {props.onOpenAttachment ? (
          <Button
            label={gt("Open attachment")}
            tone="secondary"
            onPress={props.onOpenAttachment}
            fullWidth
          />
        ) : null}
        {props.onOpenPullRequest && !pullRequestUrl ? (
          <Button
            label={gt(
              "Open {term, select, mr {merge request} cr {change request} other {pull request}}",
              { term },
            )}
            tone="secondary"
            onPress={props.onOpenPullRequest}
            fullWidth
          />
        ) : null}
        {props.onRemove ? (
          <Button
            label={gt("Remove from draft")}
            tone="secondary"
            onPress={props.onRemove}
            fullWidth
          />
        ) : null}
      </ScrollView>
    </Sheet>
  );
}
