import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import type { FileDiffMetadata } from "@pierre/diffs";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useMemo } from "react";
import { Platform, Pressable, View } from "react-native";
import { AndroidScreenHeader } from "../../../components/AndroidScreenHeader";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  letterStopNotes,
  stepTourPosition,
  stopFilePaths,
} from "@t3tools/client-runtime/review-guide-tour";
import { SymbolView } from "../../../components/AppSymbol";
import { GuideOutline } from "./GuideOutline";
import { AppText as Text } from "../../../components/AppText";
import { MaterialButton } from "../../../components/MaterialButton";
import { ScreenScrollView } from "../../../components/ScreenScrollView";
import { ControlPillMenu } from "../../../components/ControlPillMenu";
import { MaterialIconButton } from "../../../components/MaterialIconButton";
import { useAppearancePreferences } from "../../settings/appearance/AppearancePreferencesProvider";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../../native/StackHeader";
import { PullRequestCardGroup, PullRequestCardRow } from "../PullRequestControls";
import { PullRequestMarkdown, PullRequestMarkdownRepository } from "../PullRequestMarkdown";
import { usePullRequestDiff, type PullRequestParams } from "../usePullRequestDiff";
import { ReviewGuideExcerpt } from "./ReviewGuideExcerpt";
import { reviewGuideState } from "./reviewGuideState";
import { useEnvironmentQuery } from "../../../state/query";
import { composerPullRequests } from "../../../state/pull-requests";
import { usePullRequestPermissions } from "../usePullRequestPermissions";
import { pullRequestTarget } from "../usePullRequestDiff";
import { useReviewGuide } from "./useReviewGuide";

export type GuideStopParams = PullRequestParams & {
  readonly position: number;
  readonly guideHeadSha: string;
  readonly guideGeneratedAt: string;
};

const attentionLabels = {
  tradeoff: "A tradeoff to weigh",
  contract: "A contract to check",
  product: "A product call",
  risk: "A risk to judge",
  accessibility: "An accessibility call",
};

function GuideNotice({ state }: { readonly state: ReturnType<typeof useReviewGuide> }) {
  const { guide, stale, failure } = reviewGuideState(state.data);
  const error = state.startError ?? failure ?? state.error;
  const label = state.running
    ? guide
      ? "Rewriting review guide"
      : "Writing review guide"
    : error
      ? "Could not write guide"
      : stale
        ? "Guide is out of date"
        : "No review guide yet";
  if (guide && !stale && !error && !state.running) return null;
  return (
    <View
      className={guide ? "gap-3 border-l-2 border-border pl-4 py-1" : "gap-4 py-4"}
      accessibilityLiveRegion="polite"
    >
      <View className="flex-row items-center gap-2">
        <SymbolView
          name={
            state.running
              ? "clock"
              : error
                ? "exclamationmark.circle"
                : stale
                  ? "arrow.clockwise"
                  : "list.number"
          }
          size={20}
          tintColorClassName={
            error
              ? "accent-danger-foreground"
              : stale
                ? "accent-warning-foreground"
                : "accent-icon-muted"
          }
        />
        <Text className={guide ? "text-base font-t3-semibold" : "text-xl font-t3-semibold"}>
          {label}
        </Text>
      </View>
      <Text className="text-sm leading-6 text-foreground-muted">
        {error ??
          (state.running
            ? "An agent is reading the change. You can leave this screen and return when it’s ready."
            : stale
              ? "There are new changes since this guide was written. Rewrite it to see the latest code."
              : "Walk through the important code in order, with notes on what changed and where to look closely.")}
      </Text>
      {state.running ? (
        <Text className="text-xs text-foreground-muted">
          {state.data?.run?._tag === "Running"
            ? `Started at ${new Date(state.data.run.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
            : "Starting the guide…"}
        </Text>
      ) : state.canWrite ? (
        <MaterialButton
          label={error ? "Try again" : guide ? "Rewrite guide" : "Write guide"}
          tone={guide ? "secondary" : "contrast"}
          onPress={() => void state.write()}
        />
      ) : null}
    </View>
  );
}

export function PullRequestGuideContent({ params }: { readonly params: PullRequestParams }) {
  const navigation = useNavigation();
  const state = useReviewGuide(params);
  const { guide, stale } = reviewGuideState(state.data);
  return (
    <View className="w-full max-w-[760px] self-center gap-5">
      {!state.enabled ? (
        <Text>Review guides are disabled for this server.</Text>
      ) : (
        <>
          {state.isPending && !state.data ? (
            <Text className="text-foreground-muted">Loading review guide…</Text>
          ) : (
            <GuideNotice state={state} />
          )}
          {guide ? (
            <GuideOutline
              guide={guide}
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
          ) : null}
        </>
      )}
    </View>
  );
}

export function PullRequestGuideStopScreen({ route }: StaticScreenProps<GuideStopParams>) {
  const navigation = useNavigation();
  const state = useReviewGuide(route.params);
  const detail = useEnvironmentQuery(composerPullRequests.detail(pullRequestTarget(route.params)));
  const permissions = usePullRequestPermissions(route.params, detail.data);
  const canReview =
    permissions.verdicts.length > 0 && detail.data?.headSha === route.params.guideHeadSha;
  const { guide, stale } = reviewGuideState(state.data);
  const position = Math.max(0, Math.min(route.params.position, (guide?.stops.length ?? 1) - 1));
  const stop = guide?.stops[Math.max(0, position)];
  const diff = usePullRequestDiff(route.params);
  const excerptFiles = useMemo(() => {
    const files = new Map<string, FileDiffMetadata>();
    try {
      for (const patch of parsePatchFiles(diff.patch)) {
        for (const file of patch.files) {
          files.set(file.name, file);
          if (file.prevName) files.set(file.prevName, file);
        }
      }
    } catch {
      // An omitted or unparseable patch is shown as unavailable by the excerpt.
    }
    return files;
  }, [diff.patch]);
  const wanted = useMemo(() => (stop ? stopFilePaths(stop) : []), [stop]);
  const loadedPaths = new Set(
    diff.parsed.kind === "files" ? diff.parsed.files.map((file) => file.path) : [],
  );
  const missing = wanted.some((path) => !loadedPaths.has(path));
  const { error: diffError, loadMore } = diff;
  useEffect(() => {
    if (state.enabled && missing && !diffError) loadMore();
  }, [state.enabled, missing, diffError, loadMore]);
  const insets = useSafeAreaInsets();
  const changedGuide =
    guide !== null &&
    (guide.headSha !== route.params.guideHeadSha ||
      guide.generatedAt !== route.params.guideGeneratedAt);
  const { appearance, setCodeWordBreak } = useAppearancePreferences();
  const notes = stop ? letterStopNotes(stop).lettered : [];
  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions
        options={{
          title: `Stop ${route.params.position + 1}`,
          headerTitle: `Stop ${route.params.position + 1} of ${guide?.stops.length ?? "…"}`,
        }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title={`Stop ${route.params.position + 1}`}
          onBack={() => navigation.goBack()}
          trailing={
            <ControlPillMenu
              actions={[
                {
                  id: "word-wrap",
                  title: "Word wrap",
                  image: "text.alignleft",
                  state: appearance.codeWordBreak ? "on" : "off",
                },
              ]}
              onPressAction={() => setCodeWordBreak(!appearance.codeWordBreak)}
            >
              <View pointerEvents="none">
                <MaterialIconButton icon="ellipsis" accessibilityLabel="Guide options" />
              </View>
            </ControlPillMenu>
          }
        />
      ) : null}
      <NativeHeaderToolbar placement="right">
        <NativeHeaderToolbar.Menu
          title="Guide options"
          accessibilityLabel="Guide options"
          icon="ellipsis"
        >
          <NativeHeaderToolbar.MenuAction
            icon="text.alignleft"
            isOn={appearance.codeWordBreak}
            onPress={() => setCodeWordBreak(!appearance.codeWordBreak)}
          >
            <NativeHeaderToolbar.Label>Word wrap</NativeHeaderToolbar.Label>
          </NativeHeaderToolbar.MenuAction>
        </NativeHeaderToolbar.Menu>
      </NativeHeaderToolbar>
      <PullRequestMarkdownRepository
        value={`https://${route.params.host ?? "github.com"}/${route.params.repository}`}
      >
        <ScreenScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 20 }}
        >
          <View className="w-full max-w-[760px] self-center gap-5">
            {!state.enabled ? (
              <Text>Review guides are disabled for this server.</Text>
            ) : changedGuide ? (
              <Text>This guide was rewritten. Go back to start the new tour.</Text>
            ) : !stop ? (
              <Text>{state.error ?? "Loading stop…"}</Text>
            ) : (
              <>
                <GuideNotice state={state} />
                <Text className="text-2xl leading-8 font-t3-semibold">{stop.title}</Text>
                <PullRequestMarkdown markdown={stop.summary} />
                {stop.attention ? (
                  <View className="gap-3 rounded-xl border border-border bg-grouped-card p-4">
                    <View className="flex-row items-center gap-2">
                      <SymbolView name="eye" size={17} tintColorClassName="accent-icon-muted" />
                      <Text className="text-sm font-t3-semibold">
                        {attentionLabels[stop.attention.kind]}
                      </Text>
                    </View>
                    <PullRequestMarkdown markdown={stop.attention.note} />
                  </View>
                ) : null}
                {stale ? (
                  <Text className="text-sm text-foreground-muted">
                    Excerpts are hidden until the guide is rewritten for the current head.
                  </Text>
                ) : (
                  stop.excerpts.map((excerpt) => (
                    <ReviewGuideExcerpt
                      key={`${guide?.headSha}:${JSON.stringify(excerpt)}`}
                      onOpen={() =>
                        navigation.dispatch(
                          StackActions.push("PullRequestFile", {
                            ...route.params,
                            path: excerpt.path,
                            focus: { side: excerpt.side, start: excerpt.start, end: excerpt.end },
                            fileSelectionId: `guide:${position}:${excerpt.path}:${excerpt.start}`,
                          }),
                        )
                      }
                      excerpt={excerpt}
                      file={excerptFiles.get(excerpt.path)}
                      loading={diff.isPending || (missing && diff.nextCursor !== null)}
                    />
                  ))
                )}
                {diff.error ? <Text className="text-danger-foreground">{diff.error}</Text> : null}
                {notes.length ? (
                  <View className="gap-4">
                    <Text className="font-t3-semibold">Notes on this stop</Text>
                    {notes.map(({ marker, note }) => (
                      <View key={marker} className="flex-row gap-3">
                        <View className="h-7 w-7 items-center justify-center rounded-lg bg-grouped-card">
                          <Text className="text-xs font-t3-semibold">{marker}</Text>
                        </View>
                        <View className="min-w-0 flex-1 gap-2">
                          <Text className="font-t3-semibold">{note.title}</Text>
                          <Text className="text-xs text-foreground-muted">
                            {note.path.split("/").at(-1)}:{note.line}
                          </Text>
                          <PullRequestMarkdown markdown={note.body} />
                        </View>
                      </View>
                    ))}
                  </View>
                ) : null}
                {stop.files.length ? (
                  <PullRequestCardGroup>
                    {stop.files.map((file, index) => (
                      <PullRequestCardRow
                        key={file.path}
                        title={file.path}
                        detail={file.note}
                        icon="doc"
                        last={index === stop.files.length - 1}
                        onPress={() =>
                          navigation.navigate("PullRequestFile", {
                            ...route.params,
                            path: file.path,
                          })
                        }
                      />
                    ))}
                  </PullRequestCardGroup>
                ) : null}
                {stop.questions.length ? (
                  <View className="gap-3">
                    <Text className="font-t3-semibold">Questions to consider</Text>
                    {stop.questions.map((question) => (
                      <PullRequestMarkdown key={question} markdown={question} />
                    ))}
                  </View>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    guide && position < guide.stops.length - 1
                      ? "Next stop"
                      : canReview
                        ? "Finish review"
                        : "Finish tour"
                  }
                  className="mt-2 flex-row items-center gap-4 border-t border-border-subtle pt-5 pb-2 active:opacity-60"
                  onPress={() =>
                    guide && position < guide.stops.length - 1
                      ? navigation.dispatch(
                          StackActions.push("PullRequestGuideStop", {
                            ...route.params,
                            position: stepTourPosition(position, 1, guide.stops.length),
                          }),
                        )
                      : canReview
                        ? navigation.navigate("PullRequestReview", {
                            ...route.params,
                            mode: "review",
                          })
                        : navigation.dispatch(StackActions.popTo("PullRequest", route.params))
                  }
                >
                  <View className="min-w-0 flex-1 gap-1">
                    <Text className="text-xs text-foreground-muted">
                      {guide && position < guide.stops.length - 1
                        ? `Next · ${position + 2} of ${guide.stops.length}`
                        : "End of guide"}
                    </Text>
                    <Text className="text-base font-t3-semibold">
                      {guide && position < guide.stops.length - 1
                        ? guide.stops[position + 1]?.title
                        : canReview
                          ? "Finish review"
                          : "Finish tour"}
                    </Text>
                  </View>
                  <View className="h-11 w-11 items-center justify-center rounded-full bg-foreground">
                    <SymbolView
                      name={
                        guide && position < guide.stops.length - 1 ? "arrow.right" : "checkmark"
                      }
                      size={20}
                      tintColorClassName="accent-screen"
                    />
                  </View>
                </Pressable>
              </>
            )}
          </View>
        </ScreenScrollView>
      </PullRequestMarkdownRepository>
    </View>
  );
}
