import { useLocalSearchParams, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, Text as NativeText, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../../components/AppText";
import { cn } from "../../../lib/cn";
import { useThemeColor } from "../../../lib/useThemeColor";
import {
  clearReviewCommentTarget,
  formatReviewCommentContext,
  getReviewChangeMarker,
  getReviewUnifiedLineNumber,
  getSelectedReviewCommentLines,
  useReviewCommentTarget,
} from "./reviewCommentSelection";
import { appendReviewCommentToDraft } from "../use-thread-composer-state";

const REVIEW_MONO_FONT_FAMILY = Platform.select({
  ios: "ui-monospace",
  android: "monospace",
  default: "monospace",
});

function renderVisibleWhitespace(value: string): string {
  const expandedTabs = value.replace(/\t/g, "    ");
  return expandedTabs.replace(/^( +)/, (leading) => leading.replaceAll(" ", "\u00A0"));
}

function changeTone(change: "context" | "add" | "delete"): string {
  if (change === "add") return "bg-emerald-500/12";
  if (change === "delete") return "bg-rose-500/12";
  return "bg-card";
}

export function ReviewCommentComposerSheet() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const iconTint = String(useThemeColor("--color-icon"));
  const target = useReviewCommentTarget();
  const { environmentId, threadId } = useLocalSearchParams<{
    environmentId: string;
    threadId: string;
  }>();
  const [commentText, setCommentText] = useState("");

  const selectedLines = useMemo(
    () => (target ? getSelectedReviewCommentLines(target) : []),
    [target],
  );
  const firstLine = selectedLines[0] ?? null;
  const lastLine = selectedLines[selectedLines.length - 1] ?? null;
  const firstNumber = firstLine ? getReviewUnifiedLineNumber(firstLine) : null;
  const lastNumber = lastLine ? getReviewUnifiedLineNumber(lastLine) : null;
  const canSubmit =
    commentText.trim().length > 0 && target !== null && !!environmentId && !!threadId;

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{
        paddingHorizontal: 20,
        paddingTop: 8,
        paddingBottom: Math.max(insets.bottom, 18) + 18,
        gap: 16,
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

        <Pressable
          className={cn(
            "min-h-[44px] min-w-[124px] items-center justify-center rounded-full px-5",
            canSubmit ? "bg-foreground" : "border border-border bg-card",
          )}
          disabled={!canSubmit}
          onPress={() => {
            if (!target || !environmentId || !threadId || commentText.trim().length === 0) {
              return;
            }

            appendReviewCommentToDraft({
              environmentId,
              threadId,
              text: formatReviewCommentContext(target, commentText),
            });
            clearReviewCommentTarget();
            router.dismiss();
          }}
          style={{ opacity: canSubmit ? 1 : 0.55 }}
        >
          <Text
            className={cn(
              "text-[14px] font-t3-bold",
              canSubmit ? "text-background" : "text-foreground-muted",
            )}
          >
            Comment
          </Text>
        </Pressable>
      </View>

      {!target ? (
        <View className="rounded-[22px] border border-border bg-card px-4 py-5">
          <Text className="text-[15px] font-t3-bold text-foreground">No selection</Text>
          <Text className="mt-1 text-[13px] leading-[19px] text-foreground-muted">
            Select a diff line or range first.
          </Text>
        </View>
      ) : (
        <>
          <View className="gap-1 rounded-[22px] border border-border bg-card px-4 py-4">
            <Text className="font-mono text-[13px] leading-[18px] text-foreground">
              {target.filePath}
            </Text>
            <Text className="text-[12px] font-t3-medium text-foreground-muted">
              {selectedLines.length === 1
                ? firstNumber !== null
                  ? `Line ${firstNumber}`
                  : "File comment"
                : firstNumber !== null && lastNumber !== null
                  ? `Lines ${firstNumber}-${lastNumber}`
                  : `${selectedLines.length} lines selected`}
            </Text>
          </View>

          <View className="overflow-hidden rounded-[22px] border border-border bg-card">
            {selectedLines.map((line) => {
              const lineNumber = getReviewUnifiedLineNumber(line);

              return (
                <View
                  key={line.id}
                  className={cn(
                    "flex-row items-start border-b border-border/60",
                    changeTone(line.change),
                  )}
                >
                  <Text className="w-9 px-1 py-2 text-right text-[11px] font-t3-medium text-foreground-muted">
                    {lineNumber ?? ""}
                  </Text>
                  <Text
                    className="px-0.5 py-2 text-center font-mono text-[12px] text-foreground-muted"
                    style={{ width: 18 }}
                  >
                    {getReviewChangeMarker(line.change)}
                  </Text>
                  <NativeText
                    selectable
                    className="flex-1 px-1 py-2 text-[12px] leading-[19px] text-foreground"
                    style={{ fontFamily: REVIEW_MONO_FONT_FAMILY }}
                  >
                    {renderVisibleWhitespace(line.content || " ")}
                  </NativeText>
                </View>
              );
            })}
          </View>

          <View className="gap-2">
            <Text className="text-[13px] font-t3-bold text-foreground">Comment</Text>
            <TextInput
              autoFocus
              multiline
              placeholder="Leave a comment..."
              textAlignVertical="top"
              value={commentText}
              onChangeText={setCommentText}
              className="min-h-[192px] rounded-[20px] px-4 py-3.5 font-sans text-[15px]"
            />
          </View>
        </>
      )}
    </ScrollView>
  );
}
