import { Img, interpolate, staticFile } from "remotion";
import { BROWSER_VIEWPORT, type SceneCapture } from "../../shared/types.ts";
import { sans } from "../fonts.ts";
import { TrafficLights, Window } from "./Desktop.tsx";
import { TIMING, type SceneSchedule } from "./schedule.ts";

interface Page {
  url: string;
  title: string;
  screenshot: string;
}

interface BrowserState {
  /** Text in the address bar. */
  address: string;
  focused: boolean;
  /** Page on screen (undefined: a new tab). */
  page: Page | undefined;
  /** 0–1 while loading, undefined otherwise. */
  progress: number | undefined;
  /** Opacity of the page that just finished loading. */
  reveal: number;
  /** The mouse pointer over the page (page pixels), if it has been used. */
  pointer?: { x: number; y: number; pressed: number };
  /** Field or button being acted on, highlighted briefly. */
  focusRing?: { x: number; y: number; width: number; height: number; opacity: number };
}

const browserState = (capture: SceneCapture, plan: SceneSchedule, frame: number): BrowserState => {
  let state: BrowserState = {
    address: capture.start.browser?.url ?? "",
    focused: false,
    page: capture.start.browser,
    progress: undefined,
    reveal: 1,
  };
  for (const segment of plan.segments) {
    if (segment.from > frame) break;
    const { beat } = segment;
    if (beat.kind === "browser.update" && state.page) {
      const since = frame - segment.from - segment.switchFrames;
      state = {
        ...state,
        page: { ...state.page, title: beat.title, screenshot: beat.screenshot },
        reveal: interpolate(since, [0, 4], [0.85, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        }),
      };
      continue;
    }
    if (beat.kind === "browser.action" && state.page) {
      const local = frame - segment.from - segment.switchFrames;
      const { move, act } = TIMING.browserAction;
      const target = {
        x: beat.target.x + beat.target.width / 2,
        y: beat.target.y + beat.target.height / 2,
      };
      const from = state.pointer ?? {
        x: BROWSER_VIEWPORT.width * 0.62,
        y: BROWSER_VIEWPORT.height * 0.78,
      };
      const t = interpolate(local, [0, move], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      const ease = 1 - (1 - t) ** 3;
      const acted = local >= move + act / 2;
      state = {
        ...state,
        pointer: {
          x: from.x + (target.x - from.x) * ease,
          y: from.y + (target.y - from.y) * ease,
          pressed:
            beat.action === "click"
              ? interpolate(local, [move, move + act / 2, move + act], [0, 1, 0], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                })
              : 0,
        },
        focusRing: {
          ...beat.target,
          opacity: interpolate(
            local,
            [move - 4, move, move + act + 10, move + act + 20],
            [0, 1, 1, 0],
            {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            },
          ),
        },
        page: acted
          ? { ...state.page, title: beat.title, screenshot: beat.screenshot }
          : state.page,
      };
      continue;
    }
    if (beat.kind !== "browser") continue;
    const local = frame - segment.from - segment.switchFrames;
    const typingFrames = TIMING.urlPaste;
    if (local < typingFrames) {
      // Focus the address bar (selecting the old URL), then paste.
      const pasted = local >= typingFrames / 2;
      state = { ...state, address: pasted ? beat.url : "", focused: true, progress: undefined };
    } else if (local < typingFrames + TIMING.pageLoad) {
      state = {
        ...state,
        address: beat.url,
        focused: false,
        progress: (local - typingFrames) / TIMING.pageLoad,
      };
    } else {
      const since = local - typingFrames - TIMING.pageLoad;
      state = {
        address: beat.url,
        focused: false,
        page: beat,
        pointer: state.pointer,
        progress: undefined,
        reveal: interpolate(since, [0, 6], [0, 1], { extrapolateRight: "clamp" }),
      };
    }
  }
  return state;
};

const CHROME_BG = "#202124";
const TAB_BG = "#35363a";

const Icon = ({ d }: { d: string }) => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="#c4c7c5"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d={d} />
  </svg>
);

/** A macOS arrow pointer; `pressed` (0–1) shrinks it and shows a click ripple. */
const Pointer = ({ x, y, pressed }: { x: number; y: number; pressed: number }) => (
  <div style={{ position: "absolute", left: x, top: y, pointerEvents: "none" }}>
    {pressed > 0 ? (
      <div
        style={{
          position: "absolute",
          left: -22,
          top: -22,
          width: 44,
          height: 44,
          borderRadius: 22,
          background: "rgba(163, 196, 115, 0.35)",
          transform: `scale(${0.5 + pressed})`,
          opacity: pressed,
        }}
      />
    ) : null}
    <svg
      width="28"
      height="34"
      viewBox="0 0 28 34"
      style={{
        position: "absolute",
        left: -3,
        top: -2,
        transform: `scale(${1 - pressed * 0.12})`,
        filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.5))",
      }}
    >
      <path
        d="M3 2 L3 26 L9.5 20 L14 31 L18.5 29 L14 18.5 L23 18.5 Z"
        fill="#111"
        stroke="#fff"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  </div>
);

export const Browser = ({
  capture,
  plan,
  frame,
}: {
  capture: SceneCapture;
  plan: SceneSchedule;
  frame: number;
}) => {
  const state = browserState(capture, plan, frame);
  const caretVisible = state.focused && frame % 30 < 18;
  const bar = (
    <div style={{ flex: "none", background: CHROME_BG, fontFamily: sans }}>
      <div
        style={{
          height: 44,
          display: "flex",
          alignItems: "flex-end",
          padding: "0 12px 0 18px",
          gap: 18,
        }}
      >
        <div style={{ alignSelf: "center" }}>
          <TrafficLights />
        </div>
        <div
          style={{
            height: 36,
            width: 260,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "0 14px",
            borderRadius: "10px 10px 0 0",
            background: TAB_BG,
            color: "#e8eaed",
            fontSize: 14,
          }}
        >
          <div
            style={{
              width: 16,
              height: 16,
              borderRadius: 8,
              background: state.page ? "#8ab4f8" : "#5f6368",
              flex: "none",
            }}
          />
          <span style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
            {state.progress !== undefined ? "Loading…" : (state.page?.title ?? "New Tab")}
          </span>
        </div>
        <span style={{ alignSelf: "center", color: "#c4c7c5", fontSize: 22 }}>+</span>
      </div>
      <div
        style={{
          height: 48,
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "0 16px",
          background: TAB_BG,
          position: "relative",
        }}
      >
        <Icon d="M19 12H5M12 19l-7-7 7-7" />
        <Icon d="M5 12h14M12 5l7 7-7 7" />
        <Icon d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" />
        <div
          style={{
            flex: 1,
            height: 34,
            borderRadius: 17,
            background: state.focused ? "#202124" : "#282a2d",
            outline: state.focused ? "2px solid #8ab4f8" : undefined,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "0 16px",
            color: "#e8eaed",
            fontSize: 16,
          }}
        >
          <Icon d="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z" />
          <span>
            {state.address}
            {caretVisible ? (
              <span style={{ borderLeft: "2px solid #e8eaed", marginLeft: 1 }} />
            ) : null}
          </span>
        </div>
        {state.progress !== undefined ? (
          <div
            style={{
              position: "absolute",
              left: 0,
              bottom: 0,
              height: 3,
              width: `${Math.round(state.progress * 100)}%`,
              background: "#8ab4f8",
            }}
          />
        ) : null}
      </div>
    </div>
  );
  return (
    <Window background="#ffffff" bar={bar}>
      <div style={{ position: "absolute", inset: 0, background: "#202124" }}>
        {state.page ? (
          <Img
            src={staticFile(state.page.screenshot)}
            style={{
              width: BROWSER_VIEWPORT.width,
              height: BROWSER_VIEWPORT.height,
              display: "block",
              opacity: state.reveal,
            }}
          />
        ) : null}
        {state.focusRing && state.focusRing.opacity > 0 ? (
          <div
            style={{
              position: "absolute",
              left: state.focusRing.x - 4,
              top: state.focusRing.y - 4,
              width: state.focusRing.width + 8,
              height: state.focusRing.height + 8,
              borderRadius: 16,
              border: "3px solid rgba(163, 196, 115, 0.9)",
              opacity: state.focusRing.opacity,
            }}
          />
        ) : null}
        {state.pointer ? <Pointer {...state.pointer} /> : null}
      </div>
    </Window>
  );
};
