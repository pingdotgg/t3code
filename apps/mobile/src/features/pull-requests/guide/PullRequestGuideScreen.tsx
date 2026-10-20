import { StackActions, useNavigation } from "@react-navigation/native";
import { useEffect, useEffectEvent, useRef } from "react";
import { View } from "react-native";
import { useDiffWhitespacePreference } from "../../review/useDiffWhitespacePreference";
import { GuideViewOptionsButton } from "./GuideViewOptions";
import { AppText as Text } from "../../../components/ui/AppText";
import { GuideOutline } from "./GuideOutline";
import { GuideGeneratingFiles } from "./GuideGeneratingFiles";
import { reviewGuideState, shouldAutoGenerateGuide } from "./reviewGuideState";
import { GuideNotice } from "./GuideNotice";
import Animated from "react-native-reanimated";
import { PR_ROW_ENTER, PR_ROW_EXIT, PR_ROW_LAYOUT } from "../pullRequestAnimations";
import { useEnvironmentQuery } from "../../../state/query";
import { composerPullRequests } from "../../../state/pull-requests";
import {
  pullRequestTarget,
  usePullRequestDiff,
  type PullRequestParams,
} from "../usePullRequestDiff";
import type { GuideFileMetadata } from "./GuideFiles";
import { stopFilePaths } from "@t3tools/client-runtime/review-guide-tour";
import { usePullRequestFilesViewed } from "../usePullRequestFilesViewed";
import { useReviewGuide } from "./useReviewGuide";

const NO_FILES: ReadonlyArray<GuideFileMetadata> = [];

export type GuideStopParams = PullRequestParams & {
  readonly position: number;
  readonly guideHeadSha: string;
  readonly guideGeneratedAt: string;
};

export function PullRequestGuideContent({
  params,
  active = true,
}: {
  readonly params: PullRequestParams;
  readonly active?: boolean;
}) {
  const navigation = useNavigation();
  const state = useReviewGuide(params);
  const { guide, stale } = reviewGuideState(state.data);
  const detail = useEnvironmentQuery(composerPullRequests.detail(pullRequestTarget(params)));
  const viewed = usePullRequestFilesViewed(params, detail.data);
  const { ignoreWhitespace } = useDiffWhitespacePreference();
  const diff = usePullRequestDiff(params, ignoreWhitespace);
  const files = diff.parsed.kind === "files" ? diff.parsed.files : NO_FILES;
  const { loadMore } = diff;
  // Fill in counts and rename metadata for chapter files beyond the first diff page.
  const hasMissingFiles =
    guide?.stops.some((stop) =>
      stopFilePaths(stop).some((path) => !files.some((file) => file.path === path)),
    ) ?? false;
  useEffect(() => {
    if (active && hasMissingFiles && diff.canLoadMore) loadMore();
  }, [active, hasMissingFiles, diff.canLoadMore, loadMore]);
  const attempted = useRef<string | null>(null);
  const generationKey = `${params.environmentId}:${params.repository}:${params.number}:${state.data?.currentHeadSha}`;
  const shouldGenerate = active && shouldAutoGenerateGuide(state);
  const generate = useEffectEvent(() => {
    void state.write();
  });
  useEffect(() => {
    if (!shouldGenerate || attempted.current === generationKey) return;
    attempted.current = generationKey;
    generate();
  }, [shouldGenerate, generationKey]);
  return (
    <Animated.View layout={PR_ROW_LAYOUT} className="w-full max-w-[760px] self-center">
      {!state.enabled ? (
        <Text>Review guides are disabled for this server.</Text>
      ) : (
        <>
          {guide ? (
            <GuideNotice state={state} active={active} />
          ) : (
            <View className="flex-row items-start gap-2">
              <View className="min-w-0 flex-1">
                <GuideNotice state={state} active={active} />
              </View>
              <GuideViewOptionsButton />
            </View>
          )}
          {guide ? (
            <Animated.View
              key={`outline:${guide.headSha}:${guide.generatedAt}`}
              layout={PR_ROW_LAYOUT}
              entering={PR_ROW_ENTER}
              exiting={PR_ROW_EXIT}
            >
              <GuideOutline
                guide={guide}
                files={files}
                isViewed={viewed.isViewed}
                onSetChapterViewed={viewed.canToggle && !stale ? viewed.setManyViewed : undefined}
                onToggleViewed={viewed.canToggle ? viewed.toggle : undefined}
                onOpenFile={(path) => navigation.navigate("PullRequestFile", { ...params, path })}
                onOpen={(position) =>
                  navigation.dispatch(
                    StackActions.push("PullRequestGuideStop", {
                      ...params,
                      position,
                      guideHeadSha: guide.headSha,
                      guideGeneratedAt: guide.generatedAt,
                    }),
                  )
                }
                onRewrite={
                  state.canWrite && !state.running && !stale && !state.startError && !state.error
                    ? () => void state.write()
                    : undefined
                }
              />
            </Animated.View>
          ) : (
            <GuideGeneratingFiles
              files={files}
              loading={diff.isPending}
              error={diff.error}
              canLoadMore={diff.canLoadMore}
              onLoadMore={diff.loadMore}
              isViewed={viewed.isViewed}
              onToggleViewed={viewed.canToggle ? viewed.toggle : undefined}
              onOpenFile={(path) => navigation.navigate("PullRequestFile", { ...params, path })}
            />
          )}
        </>
      )}
    </Animated.View>
  );
}
