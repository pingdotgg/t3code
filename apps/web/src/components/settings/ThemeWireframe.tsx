// Preview appearance modes with default-theme tokens, regardless of the active theme.
// Set both foreground variables because foreground utilities read --contrast-foreground.
import type { CSSProperties } from "react";
import type { AppearanceChoice } from "../../hooks/useTheme";
import { LayoutPaneSkeleton, PaneNotchTab } from "../../layout/PaneSkeleton";

type Tone = "light" | "dark";

const TONE_TOKENS = {
  light: { chrome: "#e4e4e4", pane: "#f5f5f5", foreground: "#252525" },
  dark: { chrome: "#000000", pane: "#151515", foreground: "#d4d4d4" },
} as const;

function chromeVars(tone: Tone) {
  const t = TONE_TOKENS[tone];
  return {
    colorScheme: tone,
    "--app-chrome-background": t.chrome,
    "--foreground": t.foreground,
    "--contrast-foreground": t.foreground,
  } as CSSProperties;
}

function paneVars(tone: Tone) {
  const t = TONE_TOKENS[tone];
  return {
    colorScheme: tone,
    "--background": t.pane,
    "--foreground": t.foreground,
    "--contrast-foreground": t.foreground,
  } as CSSProperties;
}

const THREAD_ROW_WIDTHS = ["w-4/5", "w-3/5", "w-[70%]", "w-1/2"] as const;

function WireframeWindow({ chrome, pane }: { chrome: Tone; pane: Tone }) {
  return (
    <div className="absolute inset-0 bg-(--app-chrome-background)" style={chromeVars(chrome)}>
      <div className="absolute inset-y-0 left-0 flex w-[21%] flex-col gap-1.25 px-1.5 pt-1.5 pb-1.75">
        <div className="flex gap-0.75">
          <div className="size-1 rounded-full bg-foreground/25" />
          <div className="size-1 rounded-full bg-foreground/25" />
          <div className="size-1 rounded-full bg-foreground/25" />
        </div>
        <div className="h-2 rounded-full bg-foreground/12" />
        <div className="h-2.5 rounded-sm bg-foreground/10" />
        {THREAD_ROW_WIDTHS.map((width) => (
          <div className={`h-0.5 ${width} rounded-full bg-foreground/20`} key={width} />
        ))}
        <div className="mt-auto h-0.5 w-3/5 rounded-full bg-foreground/20" />
        <div className="h-2 rounded-sm bg-foreground/10" />
      </div>
      <div
        className="absolute top-[3px] right-[3px] bottom-[3px] left-[21%] flex flex-col overflow-hidden rounded-md rounded-tl-none bg-background"
        style={paneVars(pane)}
      >
        <PaneNotchTab className="h-3 w-[42%] shrink-0 gap-1 px-1.25" style={chromeVars(chrome)}>
          <div className="size-1 shrink-0 rounded-full bg-foreground/40" />
          <div className="h-0.5 flex-1 rounded-full bg-foreground/35" />
        </PaneNotchTab>
        <LayoutPaneSkeleton shape="chat" />
      </div>
    </div>
  );
}

export function ThemeWireframe({ mode }: { mode: AppearanceChoice }) {
  // Light frames rim with black alpha and the rest with white.
  const rim = mode === "light" ? "#00000014" : "#ffffff14";
  return (
    <div aria-hidden className="relative aspect-[188/120] w-full overflow-hidden rounded-lg">
      {mode === "system" ? (
        <>
          <WireframeWindow chrome="dark" pane="dark" />
          {/* Keep light paint off the dark rim and clip the split without an antialiased path. */}
          <div className="absolute inset-y-0 left-0 w-1/2 overflow-hidden">
            <div className="relative h-full w-[200%]">
              <WireframeWindow chrome="light" pane="light" />
            </div>
          </div>
        </>
      ) : mode === "dark" ? (
        <WireframeWindow chrome="dark" pane="dark" />
      ) : mode === "black-chrome" ? (
        <WireframeWindow chrome="dark" pane="light" />
      ) : (
        <WireframeWindow chrome="light" pane="light" />
      )}
      <div
        className="pointer-events-none absolute inset-0 rounded-lg"
        style={{ boxShadow: `inset 0 0 0 1px ${rim}` }}
      />
    </div>
  );
}
