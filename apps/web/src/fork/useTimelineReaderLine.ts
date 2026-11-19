import { useLayoutEffect, type RefObject } from "react";

import type { TimelineViewport } from "../components/chat/timelineViewport";
import { useStableCallback } from "~/hooks/useStableCallback";
import { holdTimelineReaderLine, type TimelineReaderLine } from "./timelineReaderLine";

/** Attaches the reader-line hold, with who owns the scroll read from the timeline's own state. */
export function useTimelineReaderLine(
  readerLineRef: RefObject<TimelineReaderLine | null>,
  {
    liveFollowEnabled,
    findActive,
    citationPositioning,
    restoringThreadPosition,
    listIdentityKey,
    onHoldEnd,
  }: {
    readonly liveFollowEnabled: boolean;
    readonly findActive: boolean;
    readonly citationPositioning: boolean;
    readonly restoringThreadPosition: boolean;
    readonly listIdentityKey: string;
    readonly onHoldEnd: () => void;
  },
) {
  const readerOwnsScroll =
    !liveFollowEnabled && !findActive && !citationPositioning && !restoringThreadPosition;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- find, a citation or a restore can hand the scroll back with no scroll event
  useLayoutEffect(() => {
    if (readerOwnsScroll) readerLineRef.current?.retake();
  }, [readerOwnsScroll, readerLineRef]);
  const scrollOwner = useStableCallback(() =>
    liveFollowEnabled ? "follow" : readerOwnsScroll ? "reader" : "positioning",
  );
  const threadKey = useStableCallback(() => listIdentityKey);
  const handleHoldEnd = useStableCallback(onHoldEnd);
  const attachReaderLine = useStableCallback((viewport: TimelineViewport) => {
    const readerLine = holdTimelineReaderLine({
      viewport,
      scrollOwner,
      threadKey,
      onHoldEnd: handleHoldEnd,
    });
    readerLineRef.current = readerLine;
    return () => {
      readerLine.dispose();
      if (readerLineRef.current === readerLine) readerLineRef.current = null;
    };
  });
  return attachReaderLine;
}
