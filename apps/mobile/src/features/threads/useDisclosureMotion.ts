import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

export const DISCLOSURE_DETAIL_DELAY_MS = 135;
export const DISCLOSURE_DETAIL_FADE_MS = 70;
const DISCLOSURE_SETTLE_MAX_MS = 100;

/**
 * A disclosure toggle holds rows at their old spots until layout settles, then plays the slide.
 * The hold ends two frames after the last row size change, or 100 ms after the toggle, whichever
 * comes first: a streaming turn resizes rows every frame and would otherwise restart it forever.
 * While work is active there is no hold, and a hold already in place plays at once.
 */
export function useDisclosureMotion<Motion extends { readonly playing: boolean }>(
  working: boolean,
) {
  const [layout, setLayout] = useState<Motion | null>(null);
  const motionRef = useRef<Motion | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frames = useRef<[number | null, number | null]>([null, null]);

  const cancelFrames = () => {
    for (const frame of frames.current) if (frame !== null) cancelAnimationFrame(frame);
    frames.current = [null, null];
  };

  const play = () => {
    cancelFrames();
    const motion = motionRef.current;
    if (!motion || motion.playing) return;
    if (timer.current !== null) clearTimeout(timer.current);
    const playing = { ...motion, playing: true };
    motionRef.current = playing;
    setLayout(playing);
    timer.current = setTimeout(
      () => {
        motionRef.current = null;
        setLayout(null);
        timer.current = null;
      },
      DISCLOSURE_DETAIL_DELAY_MS + DISCLOSURE_DETAIL_FADE_MS + 16,
    );
  };

  const settleAfterLayout = () => {
    cancelFrames();
    frames.current[0] = requestAnimationFrame(() => {
      frames.current[1] = requestAnimationFrame(play);
    });
  };

  const hold = (motion: Motion) => {
    if (timer.current !== null) clearTimeout(timer.current);
    motionRef.current = motion;
    setLayout(motion);
    settleAfterLayout();
    timer.current = setTimeout(play, DISCLOSURE_SETTLE_MAX_MS);
  };

  const onItemSizeChanged = () => {
    if (motionRef.current && !motionRef.current.playing) settleAfterLayout();
  };

  const releaseHold = useEffectEvent(() => play());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a turn that starts during an idle hold would keep its new rows hidden; the hold lives in timers and frame callbacks outside React
  useLayoutEffect(() => {
    if (working) releaseHold();
  }, [working]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the hold's timer and frames on unmount
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      for (const frame of frames.current) if (frame !== null) cancelAnimationFrame(frame);
    },
    [],
  );

  return {
    layout,
    /** A hold or slide is in progress, so rows may sit away from their measured spots. */
    isMoving: () => motionRef.current !== null,
    hold,
    play,
    onItemSizeChanged,
  };
}
