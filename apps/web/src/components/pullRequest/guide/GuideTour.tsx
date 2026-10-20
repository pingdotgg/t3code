import { createPortal } from "react-dom";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomValue } from "@effect/atom-react";
import { usePullRequestFilesViewed } from "../usePullRequestFilesViewed";
import type { EnvironmentId, PullRequestRef, PullRequestReviewGuide } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import { createPullRequestDiffFileContentsLoader } from "~/lib/diffFileContents";
import { isEditableFocused } from "~/lib/editableFocus";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";

import { isCommandPaletteOpen } from "~/commandPaletteBus";

import { GuideRail } from "./GuideRail";
import { GuideChapterPanel } from "./GuideChapterPanel";
import { GuideStop, type GuideStopHandle } from "./GuideStop";
import { DiffDisplayControls } from "../../diffs/DiffDisplayControls";
import type { ExcerptCommenting } from "./GuideExcerpt";
import {
  guideProgressKey,
  guideRunKey,
  useGuideProgress,
  useGuideRunStore,
  type GuideProgress,
} from "./guideRunStore";
import {
  stepTourPosition,
  stopFilePaths,
  reviewGuideStopProgress,
} from "@t3tools/client-runtime/review-guide-tour";
import { useGuideDiffFiles } from "./useGuideDiffFiles";

export function GuideTour({
  environmentId,
  reference,
  guide,
  banner,
  active,
  commenting,
  onAsk,
  onFinish,
  onOpenFile,
  viewControlsTarget,
}: {
  viewControlsTarget: HTMLElement | null;
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  guide: PullRequestReviewGuide;
  banner: ReactNode;
  active: boolean;
  commenting: ExcerptCommenting | null;
  onAsk: ((stop: number, question: string) => void) | null;
  onFinish: (() => void) | null;
  onOpenFile: (path: string) => void;
}) {
  const key = guideProgressKey(guideRunKey(environmentId, reference), guide.headSha);
  const tour = useGuideProgress(key);
  const update = (change: (current: GuideProgress) => Partial<GuideProgress>) =>
    useGuideRunStore.getState().setProgress(key, (current) => ({ ...current, ...change(current) }));
  const [railOpen, setRailOpen] = useState(false);

  const stopCount = guide.stops.length;
  const position = Math.max(Math.min(tour.position, stopCount - 1), 0);
  const stop = guide.stops[position] ?? null;
  const detail = useEnvironmentQuery(
    pullRequestEnvironment.detail({ environmentId, input: reference }),
  );
  const allowed = useAtomValue(pullRequestEnvironment.setFilesViewed.permissionAtom(environmentId));
  const viewed = usePullRequestFilesViewed({
    environmentId,
    reference,
    enabled: Boolean(detail.data?.capabilities.viewedFiles),
    paths: guide.stops.flatMap(stopFilePaths),
    headSha: guide.headSha,
  });
  const reviewedStops = new Set(
    guide.stops.flatMap((stop, index) =>
      reviewGuideStopProgress(stop, viewed.isViewed).reviewed ? [index] : [],
    ),
  );

  const wantedPaths = stop === null ? [] : stopFilePaths(stop);
  const diff = useGuideDiffFiles({
    environmentId,
    reference,
    headSha: guide.headSha,
    wantedPaths,
  });
  const getDiffFileContents = useAtomCommand(pullRequestEnvironment.diffFileContents);
  const loadDiffFiles = createPullRequestDiffFileContentsLoader(getDiffFileContents, {
    environmentId,
    reference,
    commit: null,
    cacheKey: `pull-request-guide:${key}`,
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const stopNavigation = useRef<GuideStopHandle>(null);
  const selectFile = (path: string) => {
    stopNavigation.current?.revealFile(path);
    setRailOpen(false);
  };
  const goTo = (next: number) => {
    update((current) => ({
      position: next,
      seen: next > position ? new Set(current.seen).add(position) : current.seen,
    }));
    setRailOpen(false);
    scrollRef.current?.scrollTo({ top: 0 });
  };
  const step = (delta: 1 | -1) => goTo(stepTourPosition(position, delta, stopCount));

  const stepFromKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || isCommandPaletteOpen()) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (event.key !== "j" && event.key !== "k") return;
    if (isEditableFocused(event.target)) return;
    event.preventDefault();
    step(event.key === "j" ? 1 : -1);
  });
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => stepFromKey(event);
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active]);

  return (
    // Each pane owns its scroll, so reading the diff leaves the chapter context in place.
    <div className="@container/guide flex h-full min-h-0 flex-col">
      {viewControlsTarget ? createPortal(<DiffDisplayControls />, viewControlsTarget) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <GuideChapterPanel>
          <GuideRail
            files={diff.files}
            onSelectFile={selectFile}
            stops={guide.stops}
            position={position}
            seen={reviewedStops}
            isViewed={viewed.isViewed}
            onSetViewed={
              allowed && viewed.enabled
                ? (paths, value) => {
                    for (const path of paths) viewed.setViewed(path, value);
                  }
                : null
            }
            onSelect={goTo}
          />
        </GuideChapterPanel>
        <main
          data-guide-diff-scroll
          ref={scrollRef}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
        >
          {banner ? <div className="px-4 py-3">{banner}</div> : null}
          {diff.error !== null ? (
            <p className="px-4 py-3 text-xs text-muted-foreground">
              The diff could not be loaded, so excerpts are missing: {diff.error}
            </p>
          ) : null}
          {stop === null ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              This change has no files to tour.
            </p>
          ) : (
            <GuideStop
              key={position}
              navigationRef={stopNavigation}
              stop={stop}
              isViewed={viewed.isViewed}
              onSetViewed={
                allowed && viewed.enabled
                  ? (paths, value) => {
                      for (const path of paths) viewed.setViewed(path, value);
                    }
                  : null
              }
              index={position}
              stopCount={stopCount}
              railOpen={railOpen}
              onRailOpenChange={setRailOpen}
              stopList={
                <GuideRail
                  files={diff.files}
                  onSelectFile={selectFile}
                  stops={guide.stops}
                  position={position}
                  seen={reviewedStops}
                  isViewed={viewed.isViewed}
                  onSetViewed={
                    allowed && viewed.enabled
                      ? (paths, value) => {
                          for (const path of paths) viewed.setViewed(path, value);
                        }
                      : null
                  }
                  onSelect={goTo}
                />
              }
              nextTitle={guide.stops[position + 1]?.title ?? null}
              files={diff.files}
              loadDiffFiles={loadDiffFiles}
              diffLoading={diff.loading}
              commenting={commenting}
              onStep={step}
              onAsk={onAsk === null ? null : (question) => onAsk(position, question)}
              onFinish={
                onFinish === null
                  ? null
                  : () => {
                      update((current) => ({ seen: new Set(current.seen).add(position) }));
                      onFinish();
                    }
              }
              onOpenFile={onOpenFile}
            />
          )}
        </main>
      </div>
    </div>
  );
}
