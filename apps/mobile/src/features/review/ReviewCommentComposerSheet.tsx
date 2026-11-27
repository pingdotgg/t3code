import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { TextInputWrapper } from "expo-paste-input";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { T, useGT } from "gt-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, View, useWindowDimensions } from "react-native";
import * as Dialog from "../../components/ui/Dialog";
import { FilePreviewModal, type FilePreviewSource } from "../../components/ui/FilePreviewModal";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { KeyboardSheetBody } from "../../components/ui/KeyboardSheetBody";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import { ControlPill } from "../../components/ui/ControlPill";
import { cn } from "../../lib/cn";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import { convertPastedImagesToAttachments, pickComposerImages } from "../../lib/composerImages";
import { useNativePaste } from "../../lib/useNativePaste";
import { scheduleUnusedComposerAttachmentCleanup } from "../../state/use-composer-drafts";
import { setPendingConnectionError } from "../../state/use-remote-environment-registry";
import { appendReviewCommentToDraft } from "../../state/use-thread-composer-state";
import {
  clearReviewCommentTarget,
  formatReviewCommentContext,
  getReviewUnifiedLineNumber,
  getSelectedReviewCommentLines,
  useReviewCommentTarget,
} from "./reviewCommentSelection";
import { useAppearanceCodeSurface } from "../settings/appearance/useAppearanceCodeSurface";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { changeTone, DiffTokenText, ReviewChangeBar } from "./reviewDiffRendering";
import { highlightReviewSelectedLines } from "./highlightReviewSelectedLines";

const REVIEW_COMMENT_PREVIEW_MAX_LINES = 5;
const NO_LINES: ReturnType<typeof getSelectedReviewCommentLines> = [];
const NO_HIGHLIGHTS: ReturnType<typeof highlightReviewSelectedLines> = {};

type ReviewCommentComposerSheetProps = StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}>;

export function ReviewCommentComposerSheet(props: ReviewCommentComposerSheetProps) {
  const navigation = useNavigation();
  const gt = useGT();
  const { width } = useWindowDimensions();
  const { themeAppearance: selectedTheme } = useAppearancePreferences();
  const target = useReviewCommentTarget();
  const { codeSurface } = useAppearanceCodeSurface();
  const { environmentId, threadId } = props.route.params;
  const [commentText, setCommentText] = useState("");
  const [attachments, setAttachments] = useState<ReadonlyArray<DraftComposerImageAttachment>>([]);
  const attachmentsRef = useRef(attachments);
  const isMountedRef = useRef(true);
  // Store file references before React commits, so closing the sheet can release them.
  const replaceAttachments = (next: ReadonlyArray<DraftComposerImageAttachment>) => {
    attachmentsRef.current = next;
    setAttachments(next);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases owned image files when the sheet unmounts
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      scheduleUnusedComposerAttachmentCleanup(attachmentsRef.current);
    };
  }, []);

  function appendImages(images: ReadonlyArray<DraftComposerImageAttachment>): void {
    if (!isMountedRef.current) {
      scheduleUnusedComposerAttachmentCleanup(images);
      return;
    }
    if (images.length > 0) {
      replaceAttachments([...attachmentsRef.current, ...images]);
    }
  }
  const [previewFile, setPreviewFile] = useState<FilePreviewSource | null>(null);

  const { selectedLines, highlightedLinesById } = useMemo(() => {
    if (!target) return { selectedLines: NO_LINES, highlightedLinesById: NO_HIGHLIGHTS };
    const lines = getSelectedReviewCommentLines(target);
    return {
      selectedLines: lines,
      highlightedLinesById: highlightReviewSelectedLines({
        filePath: target.filePath,
        lines,
        theme: selectedTheme,
      }),
    };
  }, [selectedTheme, target]);
  const firstLine = selectedLines[0] ?? null;
  const lastLine = selectedLines[selectedLines.length - 1] ?? null;
  const firstNumber = firstLine ? getReviewUnifiedLineNumber(firstLine) : null;
  const lastNumber = lastLine ? getReviewUnifiedLineNumber(lastLine) : null;
  const canSubmit =
    commentText.trim().length > 0 && target !== null && !!environmentId && !!threadId;
  const selectionLabel =
    selectedLines.length === 1
      ? firstNumber !== null
        ? gt("Line {line}", { line: firstNumber })
        : gt("File comment")
      : firstNumber !== null && lastNumber !== null && firstNumber < lastNumber
        ? gt("Lines {first}-{last}", { first: firstNumber, last: lastNumber })
        : gt("{count, plural, one {{count} lines selected} other {{count} lines selected}}", {
            count: selectedLines.length,
          });
  const previewHeight = Math.max(
    Math.min(selectedLines.length, REVIEW_COMMENT_PREVIEW_MAX_LINES) * codeSurface.rowHeight,
    codeSurface.rowHeight,
  );
  const previewViewportWidth = Math.max(width - 40, 280);
  const dismissComposer = () => {
    clearReviewCommentTarget();
    navigation.goBack();
  };
  const handleNativePaste = useNativePaste((uris) => {
    void (async () => {
      const result = await convertPastedImagesToAttachments({
        uris,
        existingCount: attachmentsRef.current.length,
      }).catch((error: unknown) => {
        console.error("[review comment] error converting pasted images", error);
        return null;
      });
      if (result === null) return;
      appendImages(result.attachments);
      if (result.error && isMountedRef.current) {
        Dialog.alert(gt("Could not paste image"), result.error);
      }
    })();
  });

  async function handlePickImages(): Promise<void> {
    const result = await pickComposerImages({ existingCount: attachmentsRef.current.length });
    appendImages(result.images);
    if (result.error && isMountedRef.current) {
      setPendingConnectionError(result.error);
    }
  }

  const handleSubmit = () => {
    if (!target || !environmentId || !threadId || commentText.trim().length === 0) {
      return;
    }

    appendReviewCommentToDraft({
      environmentId,
      threadId,
      text: formatReviewCommentContext(target, commentText),
      attachments: attachmentsRef.current,
    });
    scheduleUnusedComposerAttachmentCleanup(attachmentsRef.current);
    replaceAttachments([]);
    dismissComposer();
  };

  return (
    <View className="flex-1 bg-sheet">
      <SheetHeader title={gt("Add Comment")} onClose={dismissComposer} />
      <KeyboardSheetBody
        toolbar={
          target ? (
            <>
              <ControlPill
                accessibilityLabel={gt("Add image")}
                icon="plus"
                onPress={() => void handlePickImages()}
              />
              <View className="flex-1" />
              <ControlPill
                accessibilityLabel={gt("Comment", { $context: "verb, submit button" })}
                icon="arrow.up"
                label={gt("Comment", { $context: "verb, submit button" })}
                variant="primary"
                disabled={!canSubmit}
                onPress={handleSubmit}
              />
            </>
          ) : undefined
        }
      >
        {!target ? (
          <View className="rounded-[22px] border border-border bg-card px-4 py-5">
            <Text className="text-base font-t3-bold text-foreground">
              <T>No selection</T>
            </Text>
            <Text className="mt-1 text-sm leading-normal text-foreground-muted">
              <T>Select a diff line or range first.</T>
            </Text>
          </View>
        ) : (
          <View className="min-h-0 flex-1 gap-4">
            <View className="gap-1 px-1">
              <Text className="text-2xs font-t3-bold text-foreground-muted">{selectionLabel}</Text>
              <Text
                className="font-mono text-xs leading-snug text-foreground-muted"
                ellipsizeMode="middle"
                numberOfLines={2}
              >
                {target.filePath}
              </Text>
            </View>

            <View className="overflow-hidden rounded-[22px] border border-border bg-card">
              <ScrollView
                horizontal
                bounces={false}
                keyboardShouldPersistTaps="always"
                showsHorizontalScrollIndicator={false}
              >
                <ScrollView
                  bounces={false}
                  scrollEnabled={selectedLines.length > REVIEW_COMMENT_PREVIEW_MAX_LINES}
                  nestedScrollEnabled
                  keyboardShouldPersistTaps="always"
                  showsVerticalScrollIndicator={
                    selectedLines.length > REVIEW_COMMENT_PREVIEW_MAX_LINES
                  }
                  style={{ height: previewHeight }}
                >
                  <View style={{ minWidth: previewViewportWidth }}>
                    {selectedLines.map((line) => {
                      const lineNumber = getReviewUnifiedLineNumber(line);

                      return (
                        <View
                          key={line.id}
                          className={cn("flex-row items-start", changeTone(line.change))}
                          style={{ height: codeSurface.rowHeight }}
                        >
                          <ReviewChangeBar change={line.change} height={codeSurface.rowHeight} />
                          <Text className="w-9 py-1 pr-1 text-right text-2xs font-mono text-foreground-muted">
                            {lineNumber ?? ""}
                          </Text>
                          <View className="min-w-0 flex-1 shrink-0 px-1 py-1">
                            <DiffTokenText
                              fallback={line.content}
                              tokens={highlightedLinesById[line.id] ?? null}
                              change={line.change}
                              fontSize={codeSurface.fontSize}
                              lineHeight={codeSurface.rowHeight}
                            />
                          </View>
                        </View>
                      );
                    })}
                  </View>
                </ScrollView>
              </ScrollView>
            </View>

            <View className="min-h-0 flex-1 gap-2">
              <Text className="text-sm font-t3-bold text-foreground">
                <T context="noun, field label">Comment</T>
              </Text>
              <View className="min-h-[132px] flex-1 overflow-hidden rounded-[20px] border border-border bg-card">
                <View className="min-h-0 flex-1 px-4 pt-3.5">
                  <TextInputWrapper onPaste={handleNativePaste} style={{ flex: 1, minHeight: 0 }}>
                    <TextInput
                      autoFocus
                      multiline
                      scrollEnabled
                      placeholder={gt("Leave a comment...")}
                      textAlignVertical="top"
                      value={commentText}
                      onChangeText={setCommentText}
                      className="h-full min-h-0 flex-1 border-0 bg-transparent px-0 py-0 font-sans text-base"
                    />
                  </TextInputWrapper>
                </View>
                {attachments.length > 0 ? (
                  <View className="px-4 pb-3 pt-2">
                    <ComposerAttachmentStrip
                      attachments={attachments}
                      imageBorderRadius={16}
                      imageSize={60}
                      onPressPreview={setPreviewFile}
                      removeButtonPlacement="gutter"
                      onRemove={(imageId) => {
                        const current = attachmentsRef.current;
                        const removed = current.find((image) => image.id === imageId);
                        replaceAttachments(current.filter((image) => image.id !== imageId));
                        if (removed) {
                          scheduleUnusedComposerAttachmentCleanup([removed]);
                        }
                      }}
                    />
                  </View>
                ) : null}
              </View>
            </View>
          </View>
        )}
      </KeyboardSheetBody>
      <FilePreviewModal source={previewFile} onRequestClose={() => setPreviewFile(null)} />
    </View>
  );
}
