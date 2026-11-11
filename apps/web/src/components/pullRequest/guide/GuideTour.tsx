import type { EnvironmentId, PullRequestRef, PullRequestReviewGuide } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import { createPullRequestDiffFileContentsLoader } from "~/lib/diffFileContents";
import { isEditableFocused } from "~/lib/editableFocus";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";

import { isCommandPaletteOpen } from "~/commandPaletteBus";

import { GuideRail } from "./GuideRail";
import { GuideStop } from "./GuideStop";
import type { ExcerptCommenting } from "./GuideExcerpt";
import {
  guideProgressKey,
  guideRunKey,
  useGuideProgress,
  useGuideRunStore,
  type GuideProgress,
} from "./guideRunStore";
import { stepTourPosition, stopFilePaths } from "@t3tools/client-runtime/review-guide-tour";
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
}: {
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- document keydown listener for j/k tour stepping while the guide is active
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => stepFromKey(event);
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active]);

  return (
    <div ref={scrollRef} className="@container/guide h-full overflow-y-auto scrollbar-gutter-both">
      <div className="mx-auto grid max-w-[100rem] gap-6 px-4 py-4 @min-[56rem]/guide:grid-cols-[16rem_minmax(0,1fr)] @min-[90rem]/guide:gap-8 @min-[90rem]/guide:px-6">
        <aside className="sticky top-4 self-start @max-[56rem]/guide:hidden">
          <GuideRail stops={guide.stops} position={position} seen={tour.seen} onSelect={goTo} />
        </aside>
        <main className="flex min-w-0 flex-col gap-4">
          {banner}
          {diff.error !== null ? (
            <p className="text-xs text-muted-foreground">
              The diff could not be loaded, so excerpts are missing: {diff.error}
            </p>
          ) : null}
          {stop === null ? (
            <p className="text-sm text-muted-foreground">This change has no files to tour.</p>
          ) : (
            <GuideStop
              key={position}
              stop={stop}
              index={position}
              stopCount={stopCount}
              railOpen={railOpen}
              onRailOpenChange={setRailOpen}
              stopList={
                <GuideRail
                  stops={guide.stops}
                  position={position}
                  seen={tour.seen}
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
