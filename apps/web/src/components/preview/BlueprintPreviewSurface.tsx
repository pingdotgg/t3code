import type { CSSProperties, ReactNode } from "react";

interface BlueprintPreviewSurfaceProps {
  readonly children: ReactNode;
  readonly contentClassName?: string;
  readonly className?: string;
}

const DOT_GRID_STYLE: CSSProperties = {
  backgroundImage:
    "radial-gradient(circle, color-mix(in srgb, var(--color-border) 85%, transparent) 1.1px, transparent 1.35px)",
  backgroundSize: "20px 20px",
};

const CONTENT_FRAME_STYLE: CSSProperties = {
  width: "min(100%, var(--forma-preview-content-width, 100%))",
  maxWidth: "100%",
  minHeight: "100%",
};

function joinClassNames(...values: Array<string | null | undefined>) {
  return values.filter((value) => typeof value === "string" && value.length > 0).join(" ");
}

export function BlueprintPreviewSurface({
  children,
  contentClassName,
  className,
}: BlueprintPreviewSurfaceProps) {
  return (
    <div
      className={joinClassNames(
        "relative h-full min-h-full w-full overflow-hidden bg-transparent",
        className,
      )}
    >
      <div className="pointer-events-none absolute inset-0 opacity-70" style={DOT_GRID_STYLE} />
      <div className="relative z-10 grid h-full min-h-full w-full place-items-center p-8">
        <div
          className={joinClassNames("grid h-full w-full place-items-center", contentClassName)}
          style={CONTENT_FRAME_STYLE}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
