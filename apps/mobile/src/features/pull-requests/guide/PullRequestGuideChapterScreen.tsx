import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { reviewGuideStopProgress } from "@t3tools/client-runtime/review-guide-tour";
import { AndroidScreenHeader } from "../../../components/ui/AndroidScreenHeader";
import { AppText as Text } from "../../../components/ui/AppText";
import { PullRequestCommentsSheet } from "../PullRequestCommentsSheet";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { Toolbar } from "../../../components/ui/Toolbar";
import { PullRequestDiffContent } from "../PullRequestRouteScreen";
import { GuideViewOptions } from "./GuideViewOptions";
import { GuideChapterNavigation } from "./GuideChapterNavigation";
import { reviewGuideState } from "./reviewGuideState";
import { useEnvironmentQuery } from "../../../state/query";
import { composerPullRequests } from "../../../state/pull-requests";
import { pullRequestTarget } from "../usePullRequestDiff";
import { usePullRequestFilesViewed } from "../usePullRequestFilesViewed";
import { useReviewGuide } from "./useReviewGuide";
import type { GuideStopParams } from "./PullRequestGuideScreen";
import { PullRequestMarkdown, PullRequestMarkdownRepository } from "../PullRequestMarkdown";

export function PullRequestGuideStopScreen({ route }: StaticScreenProps<GuideStopParams>) {
  const params = route.params;
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const state = useReviewGuide(params);
  const detail = useEnvironmentQuery(composerPullRequests.detail(pullRequestTarget(params)));
  const viewed = usePullRequestFilesViewed(params, detail.data);
  const { guide, stale } = reviewGuideState(state.data);
  const position = Math.max(0, Math.min(params.position, (guide?.stops.length ?? 1) - 1));
  const stop = guide?.stops[position];
  const [expanded, setExpanded] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const changedGuide =
    guide !== null &&
    (guide.headSha !== params.guideHeadSha || guide.generatedAt !== params.guideGeneratedAt);
  const progress = stop ? reviewGuideStopProgress(stop, viewed.isViewed) : null;
  const title = `Chapter ${position + 1} of ${guide?.stops.length ?? "…"}`;
  const selectChapter = (nextPosition: number) => {
    navigation.setParams({ position: nextPosition });
    setExpanded(false);
  };
  return (
    <View
      className="flex-1 bg-screen"
      style={{
        paddingTop: Platform.OS === "ios" ? insets.top : 0,
        paddingBottom: Platform.OS === "ios" ? insets.bottom : 0,
      }}
    >
      <NativeStackScreenOptions options={{ title, headerTitle: title }} />
      <GuideViewOptions open={optionsOpen} onClose={() => setOptionsOpen(false)} />
      <PullRequestCommentsSheet
        params={params}
        visible={commentsOpen}
        onClose={() => setCommentsOpen(false)}
      />
      <Toolbar placement="right">
        <Toolbar.Button
          icon="slider.horizontal.3"
          accessibilityLabel="View options"
          onPress={() => setOptionsOpen(true)}
        />
        <Toolbar.Button
          icon="text.bubble"
          accessibilityLabel="Comments"
          onPress={() => setCommentsOpen(true)}
        />
      </Toolbar>
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title={title}
          onBack={() => navigation.goBack()}
          actions={[
            {
              icon: "slider.horizontal.3",
              accessibilityLabel: "View options",
              onPress: () => setOptionsOpen(true),
            },
            {
              icon: "text.bubble",
              accessibilityLabel: "Comments",
              onPress: () => setCommentsOpen(true),
            },
          ]}
        />
      ) : null}
      {!stop || changedGuide || stale ? (
        <View className="p-4">
          <Text>
            {changedGuide
              ? "This guide was rewritten. Go back to open the new chapters."
              : stale
                ? "The branch changed. Rewrite the guide before reviewing its chapters."
                : (state.error ?? "Loading chapter…")}
          </Text>
        </View>
      ) : (
        <>
          <View className="gap-1 border-b border-border-subtle bg-screen px-3 py-2">
            <GuideChapterNavigation
              chapters={guide?.stops ?? []}
              position={position}
              reviewedCount={progress?.reviewedCount ?? 0}
              fileCount={progress?.paths.length ?? 0}
              onSelect={selectChapter}
              onToggleReviewed={
                progress && viewed.canToggle
                  ? () => viewed.setManyViewed(progress.paths, !progress.reviewed)
                  : undefined
              }
            />
            <ScrollView style={{ maxHeight: expanded ? 240 : 80 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  expanded ? "Collapse chapter description" : "Expand chapter description"
                }
                onPress={() => setExpanded(!expanded)}
              >
                <Text
                  numberOfLines={expanded ? undefined : 3}
                  className="text-sm text-foreground-muted"
                >
                  {stop.summary}
                </Text>
              </Pressable>
              {expanded ? (
                <PullRequestMarkdownRepository
                  value={detail.data?.provider === "github" ? detail.data.url : null}
                  params={params}
                >
                  <View className="gap-2 pt-2">
                    {stop.attention ? <PullRequestMarkdown markdown={stop.attention.note} /> : null}
                    {stop.notes.map((note) => (
                      <View key={`${note.path}:${note.line}:${note.title}`} className="gap-1">
                        <Text className="text-sm font-t3-semibold">{note.title}</Text>
                        <Text className="text-xs text-foreground-muted">
                          {note.path}:{note.line}
                        </Text>
                        <PullRequestMarkdown markdown={note.body} />
                      </View>
                    ))}
                    {stop.questions.length ? (
                      <Text className="text-sm font-t3-semibold">Questions to consider</Text>
                    ) : null}
                    {stop.questions.map((question) => (
                      <PullRequestMarkdown key={question} markdown={question} />
                    ))}
                  </View>
                </PullRequestMarkdownRepository>
              ) : null}
            </ScrollView>
          </View>
          {progress?.paths.length ? (
            <PullRequestDiffContent
              key={`${guide?.headSha}:${position}`}
              params={{ ...params, path: "" }}
              embedded
              onlyPaths={progress.paths}
            />
          ) : null}
        </>
      )}
    </View>
  );
}
