import { useNavigation } from "@react-navigation/native";
import { countReviewThreads } from "@t3tools/client-runtime/review-threads";
import { useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { SafeAreaView } from "react-native-safe-area-context";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { PullRequestThreadCard } from "./PullRequestCommentCard";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import {
  PullRequestPendingBadge,
  PullRequestPendingCommentActions,
} from "./PullRequestPendingComment";
import { usePullRequestReviewDraft } from "./usePullRequestReviewDraft";
import type { PullRequestParams } from "./usePullRequestDiff";

/** One PR-wide checklist remains accessible while switching review tabs. */
export function PullRequestCommentsSheet({
  params,
  visible,
  onClose,
}: {
  params: PullRequestParams;
  visible: boolean;
  onClose: () => void;
}) {
  const navigation = useNavigation();
  const { themeVariables: colors } = useAppearancePreferences();
  const draft = usePullRequestReviewDraft(params);
  const [status, setStatus] = useState<"resolved" | "unresolved" | "pending">("unresolved");
  // Threads come from the optimistic activity projection, so a resolve moves its card between
  // tabs and updates every count before the host answers.
  const resolved = draft.threads.filter((thread) => thread.isResolved);
  const unresolved = draft.threads.filter((thread) => !thread.isResolved);
  const counts = countReviewThreads(draft.threads);
  // Removing the last draft also removes its tab; stay on an available status.
  const selectedStatus =
    status === "pending" && draft.comments.length === 0 ? "unresolved" : status;
  if (selectedStatus !== status) setStatus(selectedStatus);
  const threads =
    selectedStatus === "resolved" ? resolved : selectedStatus === "unresolved" ? unresolved : [];
  const pending = selectedStatus === "pending" ? draft.comments : [];
  const options = [
    {
      value: "unresolved" as const,
      label: "Unresolved",
      ...(draft.activityLoaded ? { badge: unresolved.length } : {}),
    },
    {
      value: "resolved" as const,
      label: "Resolved",
      ...(draft.activityLoaded ? { badge: resolved.length } : {}),
    },
    ...(draft.comments.length
      ? [{ value: "pending" as const, label: "Pending", badge: draft.comments.length }]
      : []),
  ];
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      {/* SafeAreaView forwards className to a native view without Uniwind styling. */}
      <SafeAreaView style={{ flex: 1, backgroundColor: colors["--color-screen"] }}>
        <View className="flex-row items-center gap-3 px-4 pt-4 pb-1">
          <View className="min-w-0 flex-1">
            <Text className="text-base font-t3-bold">Comments</Text>
            <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
              {draft.activityLoaded
                ? `${counts.open} open · ${counts.resolved} resolved`
                : draft.activityError
                  ? "Could not load comments"
                  : "Loading comments…"}
              {draft.comments.length ? ` · ${draft.comments.length} pending` : ""}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close comments"
            onPress={onClose}
            hitSlop={6}
            className="size-9 items-center justify-center rounded-xl bg-subtle active:opacity-70"
          >
            <SymbolView name="xmark" size={13} tintColorClassName="accent-icon" />
          </Pressable>
        </View>
        <View className="border-b border-border-subtle px-4 pt-2 pb-3">
          <SegmentedControl
            options={options}
            selected={selectedStatus}
            onSelect={setStatus}
            variant="tabs"
            size="compact"
          />
        </View>
        {/* Replies are written inside the cards, so the list must clear the keyboard. */}
        <KeyboardAvoidingView automaticOffset behavior="padding" style={{ flex: 1 }}>
          <ScrollView
            style={{ flex: 1 }}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: 12, gap: 8 }}
          >
            {pending.map((comment) => (
              <View
                key={comment.id}
                className="gap-1.5 rounded-xl border border-border-subtle bg-grouped-card px-3 py-2.5"
              >
                <View className="flex-row items-center gap-2">
                  <PullRequestPendingBadge />
                  <View className="flex-1" />
                  <PullRequestPendingCommentActions params={params} comment={comment} />
                </View>
                <Text className="font-mono text-2xs text-foreground-muted" numberOfLines={2}>
                  {comment.path}
                </Text>
                <PullRequestMarkdown markdown={comment.body} />
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    onClose();
                    navigation.navigate("PullRequestInlineComment", {
                      ...params,
                      draftId: comment.id,
                      path: comment.path,
                      position: comment.position,
                      headSha: comment.headSha,
                      code: comment.code,
                      ...(comment.oldPath ? { oldPath: comment.oldPath } : {}),
                    });
                  }}
                >
                  <Text className="py-2 text-xs text-foreground-muted">Open pending comment</Text>
                </Pressable>
              </View>
            ))}
            {threads.map((thread) => (
              <PullRequestThreadCard
                key={thread.id}
                params={params}
                thread={thread}
                onBeforeNavigate={onClose}
              />
            ))}
            {draft.activityError ? (
              <View className="gap-2">
                <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                  {draft.activityError}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={draft.refreshActivity}
                  className="min-h-11 justify-center active:opacity-70"
                >
                  <Text className="text-sm font-t3-medium">Try again</Text>
                </Pressable>
              </View>
            ) : !draft.activityLoaded && selectedStatus !== "pending" ? (
              <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
                Loading comments…
              </Text>
            ) : null}
            {draft.activityLoaded && !draft.activityError && !threads.length && !pending.length ? (
              <Text className="text-sm text-foreground-muted">
                {selectedStatus === "resolved"
                  ? "No resolved comments."
                  : "No unresolved comments."}
              </Text>
            ) : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
