import {
  codexFeedbackNotice,
  type CodexFeedbackSubmission,
} from "@t3tools/client-runtime/state/threads";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";

export function ComposerFeedback({
  submission,
  onDismiss,
}: {
  readonly submission: CodexFeedbackSubmission;
  readonly onDismiss: () => void;
}) {
  const notice = codexFeedbackNotice(submission);
  if (!notice) return null;
  return (
    <View className="px-4 pb-3">
      <View className="gap-2 rounded-[20px] border-continuous bg-card p-4">
        <View className="flex-row items-center gap-3">
          <Text accessibilityLiveRegion="polite" className="min-w-0 flex-1 text-sm text-foreground">
            {notice.title}
          </Text>
          {submission.status !== "uploading" ? (
            <Pressable
              accessibilityLabel="Dismiss feedback notice"
              accessibilityRole="button"
              hitSlop={12}
              onPress={onDismiss}
              className="p-1 active:opacity-60"
            >
              <SymbolView
                name="xmark"
                size={14}
                tintColorClassName="accent-icon-muted"
                type="monochrome"
              />
            </Pressable>
          ) : null}
        </View>
        {notice.description ? (
          <Text selectable className="text-xs text-foreground-muted">
            {notice.description}
          </Text>
        ) : null}
        {submission.status === "sent" ? (
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              copyTextWithHaptic(submission.feedbackId, { target: "Codex feedback thread ID" })
            }
            className="self-start py-1 active:opacity-60"
          >
            <Text className="text-sm text-foreground">Copy ID</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
