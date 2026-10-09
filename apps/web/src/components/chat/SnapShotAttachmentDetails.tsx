import type { SnapShotSource } from "@t3tools/contracts";
import { ImageIcon, TextIcon } from "lucide-react";
import { Suspense } from "react";

import { useTheme } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { HighlightedTokens } from "./HighlightedTokens";

export const SNAP_SHOT_ATTACHMENT_FRAME_CLASS =
  "relative h-28 w-52 max-w-full overflow-hidden rounded-lg border border-border/80";

export interface SnapShotAccessibilityDetails {
  content: string;
  format: "json" | "text";
}

export function SnapShotAccessibilityData({
  details,
  className,
}: {
  details: SnapShotAccessibilityDetails;
  className?: string;
}) {
  const { resolvedTheme } = useTheme();
  const content =
    details.format === "json" ? (
      <RenderErrorBoundary fallback={details.content}>
        <Suspense fallback={details.content}>
          <HighlightedTokens code={details.content} language="json" theme={resolvedTheme} />
        </Suspense>
      </RenderErrorBoundary>
    ) : (
      details.content
    );

  return (
    <pre
      className={cn(
        "overflow-auto whitespace-pre-wrap break-words font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        className,
      )}
      tabIndex={0}
    >
      {content}
    </pre>
  );
}

export function snapShotAccessibilityDetails(
  source: SnapShotSource,
): SnapShotAccessibilityDetails | undefined {
  if (source.accessibility?.format === "element-tree") {
    return {
      content: JSON.stringify(source.accessibility, null, 2),
      format: "json",
    };
  }

  const text =
    source.accessibility?.format === "flat-text"
      ? source.accessibility.text.trim()
      : source.accessibleText?.trim();
  return text ? { content: text, format: "text" } : undefined;
}

export function snapShotIncludesAccessibility(source: SnapShotSource): boolean {
  return Boolean(source.accessibility || source.accessibleText?.trim());
}

export function SnapShotContentsButton({
  source,
  className,
  side = "top",
}: {
  source: SnapShotSource;
  className?: string;
  side?: "top" | "right" | "bottom" | "left";
}) {
  const includesAccessibility = snapShotIncludesAccessibility(source);
  const ContentsIcon = includesAccessibility ? TextIcon : ImageIcon;
  const accessibilityDetails = snapShotAccessibilityDetails(source);
  const tooltip = includesAccessibility ? "Accessibility data" : "No accessibility data";

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  aria-label={
                    includesAccessibility ? "View accessibility data" : "No accessibility data"
                  }
                  className={className}
                  onClick={(event) => event.stopPropagation()}
                  size="icon-micro"
                  variant="overlay"
                />
              }
            />
          }
        >
          <ContentsIcon className="size-3" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipPopup side={side}>{tooltip}</TooltipPopup>
      </Tooltip>
      <PopoverPopup side={side} align="center" width="md">
        <div className="max-h-[min(28rem,70vh)] space-y-2 overflow-y-auto">
          <PopoverTitle>Accessibility data</PopoverTitle>
          {accessibilityDetails ? (
            <SnapShotAccessibilityData
              details={accessibilityDetails}
              className="max-h-64 rounded-md border border-border/70 bg-muted/45 p-2.5 text-2xs leading-4"
            />
          ) : includesAccessibility ? (
            <div className="rounded-md border border-border/70 bg-muted/45 p-2.5 text-muted-foreground text-xs leading-4">
              Structured accessibility elements were included, but they have no readable names or
              values.
            </div>
          ) : (
            <div className="rounded-md border border-border/70 bg-muted/45 p-2.5 text-muted-foreground text-xs leading-4">
              The app or capture backend did not provide verified accessibility data.
            </div>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function SnapShotAttachmentDetails({
  source,
  className,
}: {
  source: SnapShotSource;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 flex min-w-0 items-center gap-1.5 bg-linear-to-t from-black/85 via-black/55 to-transparent px-2.5 pb-2 pt-6",
        className,
      )}
    >
      {source.appIconDataUrl ? (
        <img src={source.appIconDataUrl} alt="" className="size-7 shrink-0 rounded-md" />
      ) : (
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-white/20 text-3xs font-medium text-white uppercase">
          {source.appName.slice(0, 1)}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 text-2xs font-medium leading-3.5 text-white">
          <span className="truncate">{source.appName}</span>
          <SnapShotContentsButton source={source} className="pointer-events-auto" />
        </div>
        <div className="truncate text-3xs leading-3.5 text-white/70">
          {source.windowTitle || "Captured window"}
        </div>
      </div>
    </div>
  );
}
