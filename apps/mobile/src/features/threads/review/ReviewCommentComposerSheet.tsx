import { useLocalSearchParams, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { TextInputWrapper } from "expo-paste-input";
import { useEffect, useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  View,
  useColorScheme,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import ImageViewing from "react-native-image-viewing";

import { AppText as Text, AppTextInput as TextInput } from "../../../components/AppText";
import { ComposerAttachmentStrip } from "../../../components/ComposerAttachmentStrip";
import { ControlPill } from "../../../components/ControlPill";
import { cn } from "../../../lib/cn";
import type { DraftComposerImageAttachment } from "../../../lib/composerImages";
import { convertPastedImagesToAttachments, pickComposerImages } from "../../../lib/composerImages";
import { useThemeColor } from "../../../lib/useThemeColor";
import { useNativePaste } from "../../../hooks/useNativePaste";
import { setPendingConnectionError } from "../../../state/use-remote-environment-registry";
import { appendReviewCommentToDraft } from "../use-thread-composer-state";
import {
  clearReviewCommentTarget,
  formatReviewCommentContext,
  getReviewChangeMarker,
  getReviewUnifiedLineNumber,
  getSelectedReviewCommentLines,
  useReviewCommentTarget,
} from "./reviewCommentSelection";
import { changeTone, DiffTokenText } from "./reviewDiffRendering";
import {
  highlightReviewSelectedLines,
  type ReviewDiffTheme,
  type ReviewHighlightedToken,
} from "./shikiReviewHighlighter";

const REVIEW_COMMENT_PREVIEW_MAX_LINES = 5;
const REVIEW_COMMENT_LINE_HEIGHT = 26;

export function ReviewCommentComposerSheet() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const colorScheme = useColorScheme();
  const iconTint = String(useThemeColor("--color-icon"));
  const target = useReviewCommentTarget();
  const { environmentId, threadId } = useLocalSearchParams<{
    environmentId: string;
    threadId: string;
  }>();
  const [commentText, setCommentText] = useState("");
  const [highlightedLinesById, setHighlightedLinesById] = useState<
    Record<string, ReadonlyArray<ReviewHighlightedToken>>
  >({});
  const [attachments, setAttachments] = useState<ReadonlyArray<DraftComposerImageAttachment>>([]);
  const [previewImageUri, setPreviewImageUri] = useState<string | null>(null);

  const selectedLines = useMemo(
    () => (target ? getSelectedReviewCommentLines(target) : []),
    [target],
  );
  const firstLine = selectedLines[0] ?? null;
  const lastLine = selectedLines[selectedLines.length - 1] ?? null;
  const firstNumber = firstLine ? getReviewUnifiedLineNumber(firstLine) : null;
  const lastNumber = lastLine ? getReviewUnifiedLineNumber(lastLine) : null;
  const selectedTheme = (colorScheme === "dark" ? "dark" : "light") satisfies ReviewDiffTheme;
  const canSubmit =
    commentText.trim().length > 0 && target !== null && !!environmentId && !!threadId;
  const selectionLabel =
    selectedLines.length === 1
      ? firstNumber !== null
        ? `Line ${firstNumber}`
        : "File comment"
      : firstNumber !== null && lastNumber !== null
        ? `Lines ${firstNumber}-${lastNumber}`
        : `${selectedLines.length} lines selected`;
  const previewHeight = Math.max(
    Math.min(selectedLines.length, REVIEW_COMMENT_PREVIEW_MAX_LINES) * REVIEW_COMMENT_LINE_HEIGHT,
    REVIEW_COMMENT_LINE_HEIGHT,
  );
  const previewViewportWidth = Math.max(width - 40, 280);
  const handleNativePaste = useNativePaste((uris) => {
    void (async () => {
      try {
        const images = await convertPastedImagesToAttachments({
          uris,
          existingCount: attachments.length,
        });
        if (images.length > 0) {
          setAttachments((current) => [...current, ...images]);
        }
      } catch (error) {
        console.error("[review comment] error converting pasted images", error);
      }
    })();
  });

  useEffect(() => {
    if (!target || selectedLines.length === 0) {
      setHighlightedLinesById({});
      return;
    }

    let cancelled = false;
    void highlightReviewSelectedLines({
      filePath: target.filePath,
      lines: selectedLines,
      theme: selectedTheme,
    })
      .then((next) => {
        if (!cancelled) {
          setHighlightedLinesById(next);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHighlightedLinesById({});
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedLines, selectedTheme, target]);

  async function handlePickImages(): Promise<void> {
    const result = await pickComposerImages({ existingCount: attachments.length });
    if (result.images.length > 0) {
      setAttachments((current) => [...current, ...result.images]);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "ios" ? 12 : 0}
      style={{ flex: 1 }}
    >
      <View
        style={{
          flex: 1,
          paddingHorizontal: 20,
          paddingTop: 8,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <View className="flex-row items-center justify-between py-2">
          <Pressable
            className="bg-subtle h-12 w-12 items-center justify-center rounded-full"
            onPress={() => {
              clearReviewCommentTarget();
              router.dismiss();
            }}
          >
            <SymbolView name="xmark" size={18} tintColor={iconTint} type="monochrome" />
          </Pressable>

          <Text className="text-[18px] font-t3-bold text-foreground">Add Comment</Text>

          <View className="h-12 w-12" />
        </View>

        {!target ? (
          <View className="rounded-[22px] border border-border bg-card px-4 py-5">
            <Text className="text-[15px] font-t3-bold text-foreground">No selection</Text>
            <Text className="mt-1 text-[13px] leading-[19px] text-foreground-muted">
              Select a diff line or range first.
            </Text>
          </View>
        ) : (
          <View className="flex-1 gap-4">
            <View className="gap-1 px-1">
              <Text className="text-[11px] font-t3-bold uppercase text-foreground-muted">
                {selectionLabel}
              </Text>
              <Text
                className="font-mono text-[12px] leading-[17px] text-foreground-muted"
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
                          style={{ height: REVIEW_COMMENT_LINE_HEIGHT }}
                        >
                          <Text className="w-9 px-1 py-1 text-right text-[11px] font-t3-medium text-foreground-muted">
                            {lineNumber ?? ""}
                          </Text>
                          <Text
                            className="px-0.5 py-1 text-center font-mono text-[12px] text-foreground-muted"
                            style={{ width: 18 }}
                          >
                            {getReviewChangeMarker(line.change)}
                          </Text>
                          <View className="min-w-0 flex-1 flex-shrink-0 px-1 py-1">
                            <DiffTokenText
                              fallback={line.content}
                              tokens={highlightedLinesById[line.id] ?? null}
                            />
                          </View>
                        </View>
                      );
                    })}
                  </View>
                </ScrollView>
              </ScrollView>
            </View>

            <View className="gap-2">
              <Text className="text-[13px] font-t3-bold text-foreground">Comment</Text>
              <View
                className="overflow-hidden rounded-[20px] border border-border bg-card"
                style={{ height: 172 }}
              >
                <View className="flex-1 px-4 pt-3.5">
                  <TextInputWrapper onPaste={handleNativePaste}>
                    <TextInput
                      autoFocus
                      multiline
                      placeholder="Leave a comment..."
                      textAlignVertical="top"
                      value={commentText}
                      onChangeText={setCommentText}
                      className="flex-1 border-0 bg-transparent px-0 py-0 font-sans text-[15px]"
                    />
                  </TextInputWrapper>
                </View>
                {attachments.length > 0 ? (
                  <View className="px-4 pb-3 pt-2">
                    <ComposerAttachmentStrip
                      attachments={attachments}
                      imageBorderRadius={16}
                      imageSize={60}
                      onPressImage={setPreviewImageUri}
                      removeButtonPlacement="gutter"
                      onRemove={(imageId) => {
                        setAttachments((current) =>
                          current.filter((image) => image.id !== imageId),
                        );
                      }}
                    />
                  </View>
                ) : null}
              </View>
            </View>

            <View className="flex-row items-center gap-3 pt-1">
              <ControlPill icon="plus" onPress={() => void handlePickImages()} />
              <View className="flex-1" />
              <ControlPill
                icon="arrow.up"
                label="Comment"
                variant="primary"
                disabled={!canSubmit}
                onPress={() => {
                  if (!target || !environmentId || !threadId || commentText.trim().length === 0) {
                    return;
                  }

                  appendReviewCommentToDraft({
                    environmentId,
                    threadId,
                    text: formatReviewCommentContext(target, commentText),
                    attachments,
                  });
                  setAttachments([]);
                  clearReviewCommentTarget();
                  router.dismiss();
                }}
              />
            </View>
          </View>
        )}
      </View>
      <ImageViewing
        images={previewImageUri ? [{ uri: previewImageUri }] : []}
        imageIndex={0}
        visible={previewImageUri !== null}
        onRequestClose={() => setPreviewImageUri(null)}
        swipeToCloseEnabled
        doubleTapToZoomEnabled
      />
    </KeyboardAvoidingView>
  );
}
