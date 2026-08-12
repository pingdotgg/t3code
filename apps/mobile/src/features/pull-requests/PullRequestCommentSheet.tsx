import type { PullRequestReviewVerdict } from "@t3tools/contracts";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo, useState } from "react";
import { Alert, Platform, Pressable, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { pullRequestEnvironment } from "../../state/pullRequests";
import { useAtomCommand } from "../../state/use-atom-command";
import { readableFailure } from "./pullRequestDetail.logic";
import { parseRoutePositiveInt, type PullRequestCommentRouteParams } from "./pullRequestNavigation";

const VERDICT_LABELS: Record<PullRequestReviewVerdict, string> = {
  comment: "Comment",
  approve: "Approve",
  "request-changes": "Request changes",
};

type PullRequestCommentSheetProps = StaticScreenProps<PullRequestCommentRouteParams>;

export function PullRequestCommentSheet(props: PullRequestCommentSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const isAndroid = Platform.OS === "android";
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const projectId = ProjectId.make(props.route.params.projectId);
  const number = parseRoutePositiveInt(props.route.params.number);
  const repository = props.route.params.repository;
  const mode = props.route.params.mode;
  const threadId = props.route.params.threadId;
  const [body, setBody] = useState("");
  const [verdict, setVerdict] = useState<PullRequestReviewVerdict>("comment");
  const [pending, setPending] = useState(false);
  const comment = useAtomCommand(pullRequestEnvironment.comment, { reportFailure: false });
  const submitReview = useAtomCommand(pullRequestEnvironment.submitReview, {
    reportFailure: false,
  });
  const replyToThread = useAtomCommand(pullRequestEnvironment.replyToThread, {
    reportFailure: false,
  });
  const title = mode === "review" ? "Submit review" : mode === "reply" ? "Reply" : "Comment";
  const canSubmit =
    number !== null &&
    !pending &&
    (mode === "review" ? true : body.trim().length > 0) &&
    (mode !== "reply" || (threadId !== undefined && threadId.length > 0));

  const submit = useCallback(async () => {
    if (number === null || !canSubmit) return;
    setPending(true);
    try {
      const reference = { projectId, repository, number };
      const result =
        mode === "review"
          ? await submitReview({
              environmentId,
              input: { ...reference, verdict, body, comments: [] },
            })
          : mode === "reply" && threadId
            ? await replyToThread({
                environmentId,
                input: { ...reference, threadId, body },
              })
            : await comment({
                environmentId,
                input: { ...reference, body },
              });
      if (AsyncResult.isFailure(result)) {
        Alert.alert(
          "Could not post",
          readableFailure(squashAtomCommandFailure(result), "The host refused this remark."),
        );
        return;
      }
      navigation.goBack();
    } finally {
      setPending(false);
    }
  }, [
    body,
    canSubmit,
    comment,
    environmentId,
    mode,
    navigation,
    number,
    projectId,
    replyToThread,
    repository,
    submitReview,
    threadId,
    verdict,
  ]);

  const verdicts = useMemo<ReadonlyArray<PullRequestReviewVerdict>>(
    () => ["comment", "approve", "request-changes"],
    [],
  );

  return (
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-sheet">
      {isAndroid ? (
        <AndroidSheetHeader title={title} onBack={() => navigation.goBack()} />
      ) : (
        <NativeStackScreenOptions
          options={{
            title,
            headerRight: () => (
              <Pressable disabled={!canSubmit} onPress={() => void submit()} hitSlop={8}>
                <Text
                  className={cn(
                    "text-base font-t3-bold",
                    canSubmit ? "text-primary" : "text-foreground-muted",
                  )}
                >
                  {pending ? "Sending…" : "Send"}
                </Text>
              </Pressable>
            ),
          }}
        />
      )}
      <View className="flex-1 px-4 pt-3" style={{ paddingBottom: Math.max(insets.bottom, 12) }}>
        {mode === "review" ? (
          <View className="mb-3 flex-row gap-2">
            {verdicts.map((option) => {
              const selected = verdict === option;
              return (
                <Pressable
                  key={option}
                  onPress={() => setVerdict(option)}
                  className={cn("rounded-full px-3 py-1.5", selected ? "bg-primary" : "bg-subtle")}
                >
                  <Text
                    className={cn(
                      "text-xs font-t3-bold",
                      selected ? "text-primary-foreground" : "text-foreground",
                    )}
                  >
                    {VERDICT_LABELS[option]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        <TextInput
          accessibilityLabel={title}
          autoFocus
          multiline
          onChangeText={setBody}
          placeholder={
            mode === "review"
              ? "Leave a review summary (optional)"
              : mode === "reply"
                ? "Reply to this conversation"
                : "Write a comment"
          }
          placeholderTextColorClassName="accent-placeholder"
          className="min-h-40 flex-1 text-base font-sans text-foreground"
          value={body}
        />
        {isAndroid ? (
          <Pressable
            disabled={!canSubmit}
            onPress={() => void submit()}
            className={cn(
              "mt-3 h-12 items-center justify-center rounded-full",
              canSubmit ? "bg-primary" : "bg-subtle",
            )}
          >
            <Text
              className={cn(
                "text-base font-t3-bold",
                canSubmit ? "text-primary-foreground" : "text-foreground-muted",
              )}
            >
              {pending ? "Sending…" : "Send"}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}
