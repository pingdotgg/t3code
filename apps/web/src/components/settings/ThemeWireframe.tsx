// A neutral miniature of the window (pen eWIa5 wireframes): the chrome with
// the sidebar and a tab, and the inset pane with a conversation and the
// composer. It shows the appearance mode, not the theme, so it keeps the
// default palette. Drawn as one static SVG on the pen's 188x120 grid.
import { useId } from "react";
import type { AppearanceChoice } from "../../hooks/useTheme";

type ChromeTone = "light" | "dark";
type PaneTone = "light" | "dark";

const CHROME_COLORS = {
  light: {
    window: "#e4e4e4",
    search: "#fafafa",
    searchStroke: "#00000012",
    threadActive: "#f5f5f5",
    threadTitle: "#00000026",
    thread: "#0000001a",
  },
  dark: {
    window: "#000000",
    search: "#1c1c1c",
    searchStroke: null,
    threadActive: "#1f1f1f",
    threadTitle: "#ffffff3a",
    thread: "#ffffff1f",
  },
} as const;

const PANE_COLORS = {
  light: {
    pane: "#f5f5f5",
    // The tab is the notch cut into the pane, so it follows the pane.
    tab: "#f5f5f5",
    tabLabel: "#00000059",
    bubble: "#e6e6e6",
    line: "#00000017",
    working: "#00000024",
    row: "#0000000e",
    tray: "#ffffff",
    trayStroke: "#00000014",
    send: "#1a1a1a",
  },
  dark: {
    pane: "#151515",
    tab: "#2a2a2a",
    tabLabel: "#ffffff66",
    bubble: "#262626",
    line: "#ffffff1c",
    working: "#ffffff26",
    row: "#ffffff10",
    tray: "#1f1f1f",
    trayStroke: "#ffffff14",
    send: "#eeeeee",
  },
} as const;

const THREAD_ROWS = [
  { y: 28, width: 20 },
  { y: 35, width: 26 },
  { y: 42, width: 16 },
  { y: 49, width: 24 },
  { y: 56, width: 18 },
] as const;

const WORK_ROWS = [
  { y: 34, width: 50 },
  { y: 39, width: 62 },
  { y: 44, width: 44 },
  { y: 49, width: 56 },
] as const;

function WireframeWindow({ chrome, pane }: { chrome: ChromeTone; pane: PaneTone }) {
  const c = CHROME_COLORS[chrome];
  const p = PANE_COLORS[pane];
  return (
    <g>
      <rect fill={c.window} height="120" width="188" />
      <rect
        fill={c.search}
        height="5"
        rx="2.5"
        width="36"
        x="6"
        y="8"
        {...(c.searchStroke ? { stroke: c.searchStroke, strokeWidth: 0.75 } : {})}
      />
      <rect fill={c.threadActive} height="6" rx="2" width="36" x="6" y="18" />
      <rect fill={c.threadTitle} height="2" rx="1" width="22" x="9" y="20" />
      {THREAD_ROWS.map((row) => (
        <rect fill={c.thread} height="2" key={row.y} rx="1" width={row.width} x="9" y={row.y} />
      ))}
      <rect fill={c.thread} height="2" rx="1" width="14" x="9" y="108" />
      <rect fill={c.thread} height="2" rx="1" width="18" x="9" y="112" />
      <rect fill={p.tab} height="6" rx="3" width="26" x="52" y="3" />
      <rect fill={p.tabLabel} height="2" rx="1" width="14" x="56" y="6" />
      <g transform="translate(48 11)">
        <rect fill={p.pane} height="105" rx="6" width="136" />
        <rect fill={p.bubble} height="12" rx="4" width="50" x="78" y="8" />
        <rect fill={p.line} height="2" rx="1" width="36" x="82" y="12" />
        <rect fill={p.line} height="2" rx="1" width="24" x="82" y="16" />
        <rect fill={p.working} height="2" rx="1" width="30" x="10" y="27" />
        <rect fill={p.row} height="2" rx="1" width="30" x="94" y="27" />
        {WORK_ROWS.map((row) => (
          <g key={row.y}>
            <rect fill={p.line} height="3" rx="1" width="3" x="10" y={row.y} />
            <rect fill={p.row} height="2" rx="1" width={row.width} x="16" y={row.y + 1} />
          </g>
        ))}
        <rect
          fill={p.tray}
          height="19"
          rx="5"
          stroke={p.trayStroke}
          strokeWidth="1"
          width="111"
          x="12.5"
          y="79.5"
        />
        <rect fill={p.line} height="2" rx="1" width="42" x="18" y="86" />
        <circle cx="115.5" cy="87.5" fill={p.send} r="3.5" />
        <rect fill={p.row} height="2" rx="1" width="28" x="18" y="94" />
      </g>
    </g>
  );
}

export function ThemeWireframe({ mode }: { mode: AppearanceChoice }) {
  // The pen rims light wireframes with black alpha and the rest with white.
  const rim = mode === "light" ? "#00000014" : "#ffffff14";
  // Several wireframes render at once, so clip ids must be unique.
  const id = useId();
  const frameClipId = `${id}-frame`;
  const darkHalfClipId = `${id}-dark-half`;
  return (
    <svg
      aria-hidden
      className="block aspect-[188/120] w-full"
      preserveAspectRatio="xMidYMid slice"
      viewBox="0 0 188 120"
    >
      <defs>
        <clipPath id={frameClipId}>
          <rect height="120" rx="8" width="188" />
        </clipPath>
        <clipPath id={darkHalfClipId}>
          <rect height="120" width="94" x="94" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${frameClipId})`}>
        {mode === "system" ? (
          <>
            <WireframeWindow chrome="light" pane="light" />
            <g clipPath={`url(#${darkHalfClipId})`}>
              <WireframeWindow chrome="dark" pane="dark" />
            </g>
          </>
        ) : mode === "dark" ? (
          <WireframeWindow chrome="dark" pane="dark" />
        ) : mode === "black-chrome" ? (
          <WireframeWindow chrome="dark" pane="light" />
        ) : (
          <WireframeWindow chrome="light" pane="light" />
        )}
      </g>
      <rect fill="none" height="119" rx="7.5" stroke={rim} width="187" x="0.5" y="0.5" />
    </svg>
  );
}
