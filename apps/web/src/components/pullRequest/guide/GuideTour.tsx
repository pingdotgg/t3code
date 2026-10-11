import type { EnvironmentId, PullRequestRef, PullRequestReviewGuide } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from "react";

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
import { stepTourPosition, stopFilePaths } from "./guideTour.logic";
import { useGuideDiffFiles } from "./useGuideDiffFiles";

/**
 * The guide as a tour: a rail of stops beside the stop being read. Progress is kept per guide
 * head for as long as the app is open, so the same guide in another panel opens where the reader
 * is; a new head starts it over. What
 * the reader says about the change goes into the review: line comments queue with the Code tab's,
 * and the last stop opens the composer that sends them.
 */
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
  /** The stale or failed notice, shown above whichever view is open. */
  banner: ReactNode;
  /** Whether the tour is the tab on screen, which is when J and K step through it. */
  active: boolean;
  commenting: ExcerptCommenting | null;
  /** Opens an agent thread about a stop. Null where the reader cannot start one. */
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

  // Only the open stop's files are read: its excerpts, and the files it lists to open in place.
  const wantedPaths = useMemo(() => (stop === null ? [] : stopFilePaths(stop)), [stop]);
  const diff = useGuideDiffFiles({
    environmentId,
    reference,
    headSha: guide.headSha,
    wantedPaths,
  });
  // The same file reads the Code tab uses, so the bars between hunks load what lies between.
  const getDiffFileContents = useAtomCommand(pullRequestEnvironment.diffFileContents);
  const loadDiffFiles = useMemo(
    () =>
      createPullRequestDiffFileContentsLoader(getDiffFileContents, {
        environmentId,
        reference,
        commit: null,
        cacheKey: `pull-request-guide:${key}`,
      }),
    [environmentId, getDiffFileContents, key, reference],
  );

  // A new stop starts at its top rather than wherever the last one was scrolled to.
  const scrollRef = useRef<HTMLDivElement>(null);
  const goTo = (next: number) => {
    // Leaving a stop for a later one is reading it; jumping back is not.
    update((current) => ({
      position: next,
      seen: next > position ? new Set(current.seen).add(position) : current.seen,
    }));
    setRailOpen(false);
    scrollRef.current?.scrollTo({ top: 0 });
  };
  const step = (delta: 1 | -1) => goTo(stepTourPosition(position, delta, stopCount));

  // J and K step through the tour whenever it is the tab on screen, wherever focus is, unless
  // the reader is typing: clicking a stop in the rail leaves focus on a button outside any
  // element that could hold a key handler of its own.
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
    // Three widths: one column with the rail folded; the rail beside the stop; and, on a
    // maximized panel, the stop's notes in a column of their own (see GuideStop).
    <div ref={scrollRef} className="@container/guide h-full overflow-y-auto scrollbar-gutter-both">
      <div className="mx-auto grid max-w-[100rem] gap-6 px-4 py-4 @min-[56rem]/guide:grid-cols-[16rem_minmax(0,1fr)] @min-[90rem]/guide:gap-8 @min-[90rem]/guide:px-6">
        {/* Beside the stop on a wide panel; narrow, the stop folds the same list open under its
            header instead. */}
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
