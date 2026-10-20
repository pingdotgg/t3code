import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { reviewLineRangeLabel } from "@t3tools/client-runtime/review-selection";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { ActivityIndicator, Platform, ScrollView, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { NativeScrollViewMarker as ScrollViewMarker } from "../../native/NativeScrollViewMarker";
import { AppText as Text } from "../../components/ui/AppText";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { Button } from "../../components/ui/Button";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { PullRequestThreadCard } from "./PullRequestCommentCard";
import { PullRequestMarkdownRepository } from "./PullRequestMarkdown";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { pullRequestReviewKey } from "./pullRequestReviewDrafts";

export function PullRequestDiscussionScreen({
  route,
}: StaticScreenProps<PullRequestParams & { readonly discussionId: string }>) {
  return (
    <Discussion
      key={`${pullRequestReviewKey(route.params)}:${route.params.discussionId}`}
      params={route.params}
    />
  );
}

/** A diff annotation's conversation, in the same card the Overview and Comments sheet use. */
function Discussion({ params }: { params: PullRequestParams & { readonly discussionId: string } }) {
  const target = pullRequestTarget(params);
  const navigation = useNavigation();
  const activity = useEnvironmentQuery(composerPullRequests.activity(target));
  const detail = useEnvironmentQuery(composerPullRequests.detail(target));
  const thread = activity.data?.reviewThreads.find((thread) => thread.id === params.discussionId);
  return (
    <PullRequestMarkdownRepository
      params={params}
      value={detail.data?.provider === "github" ? detail.data.url : null}
    >
      <KeyboardAvoidingView automaticOffset behavior="height" className="flex-1 bg-screen">
        <NativeStackScreenOptions
          options={{ title: "Discussion", unstable_headerSubtitle: `#${params.number}` }}
        />
        {Platform.OS === "android" ? (
          <AndroidScreenHeader
            title="Discussion"
            subtitle={`#${params.number}`}
            onBack={() => navigation.goBack()}
          />
        ) : null}
        <ScrollViewMarker style={{ flex: 1 }}>
          <ScrollView
            className="flex-1"
            contentInsetAdjustmentBehavior="automatic"
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: 16, paddingBottom: 24, gap: 12 }}
          >
            {activity.isPending && !thread ? <AppActivityIndicator /> : null}
            {thread ? (
              <>
                <View className="flex-row items-center gap-2">
                  <Text
                    selectable
                    className="min-w-0 flex-1 font-mono text-xs text-foreground-muted"
                    numberOfLines={2}
                  >
                    {thread.path} · {reviewLineRangeLabel(thread)}
                    {thread.isOutdated ? " · Outdated" : ""}
                  </Text>
                  <Button
                    label="View diff"
                    onPress={() =>
                      navigation.navigate("PullRequestFile", { ...params, path: thread.path })
                    }
                  />
                </View>
                {/* Opened on purpose from the diff, so even a resolved thread starts unfolded. */}
                <PullRequestThreadCard
                  params={params}
                  thread={thread}
                  showPath={false}
                  defaultExpanded
                />
              </>
            ) : !activity.isPending ? (
              <Text>This discussion is no longer available.</Text>
            ) : null}
            {activity.error ? (
              <Text selectable className="text-sm text-danger-foreground">
                {activity.error}
              </Text>
            ) : null}
          </ScrollView>
        </ScrollViewMarker>
      </KeyboardAvoidingView>
    </PullRequestMarkdownRepository>
  );
}
