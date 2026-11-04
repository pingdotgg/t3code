import { useEffect, useRef } from "react";
import {
  Freeze,
  getRemotionEnvironment,
  OffthreadVideo,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  TAB_BAR,
  TERMINAL,
  TITLE_BAR,
  type SceneCapture,
  type TerminalTab,
} from "../../shared/types.ts";
import { sans } from "../fonts.ts";
import { TrafficLights, Window } from "./Desktop.tsx";
import type { SceneSchedule } from "./schedule.ts";

/** Ghostty's default dark background, matching the recorded clip. */
const BACKGROUND = "#282c34";
/** Ghostty's macOS chrome: title bar and native tab bar. */
const CHROME = "#21252b";
const TAB_IDLE = "#1b1e23";
const DIVIDER = "rgba(0,0,0,0.45)";

const TABS: TerminalTab[] = ["deploy", "test", "dev"];
const TAB_TITLES: Record<TerminalTab, string> = {
  deploy: "deploy",
  test: "test",
  dev: "dev",
};

/** Position in the terminal clip at `frame`: plays during terminal beats, holds between them. */
const clipTime = (plan: SceneSchedule, frame: number, fps: number): number => {
  let time: number | undefined;
  for (const segment of plan.segments) {
    const { beat } = segment;
    if (beat.kind !== "terminal") continue;
    if (segment.from > frame) {
      // Before the first terminal beat: its opening frame (a fresh prompt).
      time ??= beat.start;
      break;
    }
    const elapsed = Math.max(0, frame - segment.from - segment.switchFrames) / fps;
    time = Math.min(beat.start + elapsed, beat.end);
  }
  return time ?? 0;
};

/** The tab on screen at clip time `time`. */
const tabAt = (capture: SceneCapture, time: number): TerminalTab => {
  let active: TerminalTab = capture.terminal?.tabs?.[0]?.tab ?? "deploy";
  for (const change of capture.terminal?.tabs ?? []) {
    if (change.at > time) break;
    active = change.tab;
  }
  return active;
};

const GhosttyIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" style={{ flex: "none", opacity: 0.8 }}>
    <path
      d="M12 2C7.6 2 4.5 5.3 4.5 9.6V20c0 .9 1 1.4 1.7.8l1.6-1.3 1.6 1.3c.4.3 1 .3 1.3 0L12 19.5l1.3 1.3c.4.3.9.3 1.3 0l1.6-1.3 1.6 1.3c.7.6 1.7.1 1.7-.8V9.6C19.5 5.3 16.4 2 12 2Z"
      fill="#d9d9d9"
    />
    <circle cx="9.5" cy="10" r="1.4" fill="#21252b" />
    <circle cx="14.5" cy="10" r="1.4" fill="#21252b" />
  </svg>
);

/** Title bar plus Ghostty's native macOS tab bar (equal-width tabs, selected one merges with the terminal). */
const Chrome = ({ active }: { active: TerminalTab }) => (
  <div style={{ flex: "none", fontFamily: sans }}>
    <div
      style={{
        height: TITLE_BAR,
        display: "flex",
        alignItems: "center",
        padding: "0 18px",
        position: "relative",
        background: CHROME,
      }}
    >
      <TrafficLights />
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          color: "#c8c8c8",
          fontSize: 14,
          fontWeight: 600,
        }}
      >
        <GhosttyIcon />
        {TAB_TITLES[active]}
      </div>
    </div>
    <div
      style={{
        height: TAB_BAR,
        display: "flex",
        background: TAB_IDLE,
        borderTop: `1px solid ${DIVIDER}`,
      }}
    >
      {TABS.map((tab, i) => {
        const selected = tab === active;
        return (
          <div
            key={tab}
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
              background: selected ? BACKGROUND : TAB_IDLE,
              borderLeft: i > 0 ? `1px solid ${DIVIDER}` : undefined,
              color: selected ? "#f0f0f0" : "#8b8f96",
              fontSize: 13.5,
              fontWeight: selected ? 600 : 500,
            }}
          >
            {TAB_TITLES[tab]}
            <span
              style={{
                position: "absolute",
                right: 14,
                color: "#6b7078",
                fontSize: 12,
              }}
            >
              ⌘{i + 1}
            </span>
          </div>
        );
      })}
      <div
        style={{
          width: 38,
          display: "grid",
          placeItems: "center",
          color: "#8b8f96",
          fontSize: 18,
          borderLeft: `1px solid ${DIVIDER}`,
        }}
      >
        +
      </div>
    </div>
  </div>
);

/**
 * In the live presenter, seeking a video to an exact frame on every frame
 * stalls, so the terminal plays as a normal <video> kept in step with the
 * timeline: it plays while clip time advances and is re-seeked only when it
 * drifts or jumps.
 */
const LiveClip = ({ src, time }: { src: string; time: number }) => {
  const ref = useRef<HTMLVideoElement>(null);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const last = useRef({ frame, time });
  const idle = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const advancing = frame === last.current.frame + 1 && time > last.current.time;
    last.current = { frame, time };
    if (Math.abs(video.currentTime - time) > 0.25) video.currentTime = time;
    if (advancing && video.paused) video.play().catch(() => {});
    if (!advancing && !video.paused) video.pause();
    // The timeline stopped (end of a step, pause): stop the clip on the frame it's showing.
    clearTimeout(idle.current);
    idle.current = setTimeout(
      () => {
        video.pause();
        video.currentTime = last.current.time;
      },
      (2 * 1000) / fps,
    );
  }, [frame, time, fps]);
  useEffect(() => () => clearTimeout(idle.current), []);
  return (
    <video
      ref={ref}
      src={src}
      muted
      playsInline
      preload="auto"
      style={{ width: TERMINAL.width, height: TERMINAL.height, display: "block" }}
    />
  );
};

export const Terminal = ({
  capture,
  plan,
  frame,
  fps,
}: {
  capture: SceneCapture;
  plan: SceneSchedule;
  frame: number;
  fps: number;
}) => {
  const time = clipTime(plan, frame, fps);
  const active = tabAt(capture, time);
  // Stay one frame inside the clip so the last frame is always decodable.
  const last = capture.terminal ? Math.max(0, Math.floor(capture.terminal.duration * fps) - 1) : 0;
  const videoFrame = Math.min(Math.round(time * fps), last);
  return (
    <Window background={BACKGROUND} bar={<Chrome active={active} />}>
      {capture.terminal && getRemotionEnvironment().isPlayer ? (
        <LiveClip src={staticFile(capture.terminal.clip)} time={time} />
      ) : capture.terminal ? (
        <Freeze frame={videoFrame}>
          <OffthreadVideo
            src={staticFile(capture.terminal.clip)}
            muted
            style={{ width: TERMINAL.width, height: TERMINAL.height, display: "block" }}
          />
        </Freeze>
      ) : null}
    </Window>
  );
};
