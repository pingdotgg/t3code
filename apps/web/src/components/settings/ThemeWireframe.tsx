import { cn } from "../../lib/utils";
import type { ThemeCardPreviewColors } from "./ThemePreviewCircles";

// A simple miniature of the app: sidebar, a short conversation, the
// composer, and the orchestrator panel floating over the interface as an
// island with horizontal agent rows.
export function ThemeWireframePane({
  colors,
  clip,
}: {
  colors: ThemeCardPreviewColors;
  clip?: "left" | "right" | undefined;
}) {
  const line = "rgb(127 127 127 / 0.25)";
  return (
    <span
      className="absolute inset-0"
      style={
        clip === undefined
          ? undefined
          : {
              clipPath:
                clip === "left"
                  ? "polygon(0 0, calc(50% - 1px) 0, calc(50% - 1px) 100%, 0 100%)"
                  : "polygon(calc(50% + 1px) 0, 100% 0, 100% 100%, calc(50% + 1px) 100%)",
            }
      }
    >
      <span className="absolute inset-0" style={{ backgroundColor: colors.canvas }} />
      <span
        className="absolute inset-y-0 left-0 w-[22%]"
        style={{ backgroundColor: colors.sidebar, boxShadow: `inset -1px 0 0 ${line}` }}
      />

      {/* Sidebar: search, then thread rows */}
      <span
        className="absolute left-[3%] top-[8%] h-[8%] w-[16%] rounded-md"
        style={{ backgroundColor: colors.surface, boxShadow: `inset 0 0 0 1px ${line}` }}
      />
      <span
        className="absolute left-[3%] top-[22%] h-[7%] w-[16%] rounded-md"
        style={{ backgroundColor: colors.accentSurface }}
      />
      <span
        className="absolute left-[3%] top-[32%] h-[7%] w-[16%] rounded-md"
        style={{ backgroundColor: colors.messageSurface, opacity: 0.7 }}
      />
      <span
        className="absolute left-[3%] top-[42%] h-[7%] w-[16%] rounded-md"
        style={{ backgroundColor: colors.messageSurface, opacity: 0.5 }}
      />

      {/* Conversation */}
      <span
        className="absolute right-[28%] top-[11%] h-[9%] w-[24%] rounded-lg"
        style={{ backgroundColor: colors.messageSurface }}
      />
      <span
        className="absolute left-[27%] top-[28%] h-[5%] w-[34%] rounded-sm"
        style={{ backgroundColor: line }}
      />
      <span
        className="absolute left-[27%] top-[38%] h-[5%] w-[26%] rounded-sm"
        style={{ backgroundColor: line }}
      />

      {/* Composer */}
      <span
        className="absolute bottom-[8%] left-[26%] right-[6%] flex h-[15%] items-center justify-between rounded-md px-[2.5%]"
        style={{
          backgroundColor: colors.surface,
          boxShadow: `inset 0 0 0 1px ${line}`,
        }}
      >
        <span
          className="block h-[26%] w-[34%] rounded-full"
          style={{ backgroundColor: line, opacity: 0.7 }}
        />
        <span
          className="block aspect-square h-[58%] rounded-full"
          style={{ backgroundColor: colors.messageAction }}
        />
      </span>

      {/* Orchestrator island floating over the composer */}
      <span
        className="absolute right-[5%] top-[8%] h-[46%] w-[20%] rounded-lg"
        style={{
          backgroundColor: colors.surface,
          boxShadow: `inset 0 0 0 1px ${line}, 0 2px 5px rgb(0 0 0 / 0.14)`,
        }}
      >
        {[0, 1, 2].map((row) => (
          <span
            className="absolute left-[11%] right-[11%] flex items-center gap-[5%]"
            key={row}
            style={{ top: `${10 + row * 30}%`, height: "20%" }}
          >
            <span
              className="block aspect-square h-[26%] rounded-full"
              style={{
                backgroundColor:
                  row === 0 ? "#34d399" : row === 1 ? colors.messageAction : "#fbbf24",
                opacity: 0.55,
              }}
            />
            <span className="block h-[30%] w-[52%] rounded-sm" style={{ backgroundColor: line }} />
          </span>
        ))}
      </span>
    </span>
  );
}

export function ThemeWireframe({
  className,
  panes,
}: {
  /** Sizing (height) for the frame; the pane geometry is percentage based. */
  className?: string;
  panes: ReadonlyArray<{ colors: ThemeCardPreviewColors; clip?: "left" | "right" }>;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative block w-full overflow-hidden rounded-lg border border-border/60",
        className,
      )}
    >
      {panes.map((pane) => (
        <ThemeWireframePane clip={pane.clip} colors={pane.colors} key={pane.clip ?? "pane"} />
      ))}
    </span>
  );
}
