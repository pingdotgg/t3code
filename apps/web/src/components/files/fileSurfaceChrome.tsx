import { FileWarning, RotateCw } from "lucide-react";
import type { ReactNode } from "react";

import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";

import { Spinner } from "~/components/ui/spinner";
import { Button } from "~/components/ui/button";
import { Toggle } from "~/components/ui/toggle";
import { Toggle as ToggleGroupItem, ToggleGroup } from "~/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { DIFF_SURFACE_THEME_UNSAFE_CSS } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";

export const FILE_SURFACE_SUBHEADER_CLASS =
  "flex h-10 min-h-10 shrink-0 items-center gap-2 border-b border-divider bg-background ps-4 pe-3 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-divider";

export const FILE_LINK_REVEAL_ATTRIBUTE = "data-file-link-reveal";

export const FILE_LINK_REVEAL_UNSAFE_CSS = `
  ${DIFF_SURFACE_THEME_UNSAFE_CSS}

  :host {
    --code-background: var(--code-surface, var(--background));
  }

  diffs-container {
    --diffs-bg: var(--code-surface, var(--background)) !important;
    --diffs-light-bg: var(--code-surface, var(--background)) !important;
    --diffs-dark-bg: var(--code-surface, var(--background)) !important;
    background-color: var(--code-surface, var(--background)) !important;
    color: var(--code-foreground, var(--foreground)) !important;
  }

  /* Tint through --diffs-line-bg, not background-color. The editor paints row
     tints on a layer below its text selection; a background on the row itself
     covers the selection and makes selected text on this line invisible. */
  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-line] {
    --diffs-line-bg: light-dark(
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 82%,
        var(--diffs-bg-selection-override, var(--diffs-selection-base))
      ),
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 75%,
        var(--diffs-bg-selection-override, var(--diffs-selection-base))
      )
    ) !important;
  }

  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-column-number] {
    background-color: light-dark(
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 75%,
        var(--diffs-bg-selection-number-override, var(--diffs-selection-base))
      ),
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 60%,
        var(--diffs-bg-selection-number-override, var(--diffs-selection-base))
      )
    ) !important;
    color: var(--diffs-selection-number-fg) !important;
  }
`;

export function FileSurfaceAction(props: {
  readonly label: string;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  const pressed = props.pressed;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          pressed === undefined ? (
            <Button
              type="button"
              className="shrink-0"
              disabled={props.disabled ?? false}
              onClick={props.onPress}
              aria-label={props.label}
              variant="ghost"
              size="icon-sm"
            >
              {props.children}
            </Button>
          ) : (
            <Toggle
              className="shrink-0"
              pressed={pressed}
              disabled={props.disabled ?? false}
              onPressedChange={props.onPress}
              aria-label={props.label}
              variant="ghost"
              size="sm"
            >
              {props.children}
            </Toggle>
          )
        }
      />
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

export type FileRenderedMode = "markdown" | "mermaid" | "html" | "table";

/**
 * The Preview/Source switch for files that have a rendered view. Workspace
 * files and attachments share it so both headers read the same.
 */
export function FileRenderedViewToggle(props: {
  readonly mode: FileRenderedMode;
  readonly rendered: boolean;
  readonly onRenderedChange: (rendered: boolean) => void;
}) {
  const { mode } = props;
  return (
    <ToggleGroup
      aria-label="File view"
      className="shrink-0"
      value={[props.rendered ? "rendered" : "source"]}
      onValueChange={(value) => {
        const next = value[0];
        if (next === "rendered" || next === "source") props.onRenderedChange(next === "rendered");
      }}
    >
      <ToggleGroupItem
        aria-label={
          mode === "mermaid"
            ? "Show rendered diagram"
            : mode === "markdown"
              ? "Show rendered markdown"
              : mode === "table"
                ? "Show table"
                : "Show rendered page"
        }
        value="rendered"
      >
        {mode === "table" ? "Table" : "Preview"}
      </ToggleGroupItem>
      <ToggleGroupItem
        aria-label={
          mode === "mermaid"
            ? "Show Mermaid source"
            : mode === "markdown"
              ? "Show markdown source"
              : mode === "table"
                ? "Show source"
                : "Show HTML source"
        }
        value="source"
      >
        Source
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

export function FileSurfaceNotice(props: { readonly children: ReactNode }) {
  return (
    <div
      role="status"
      className="shrink-0 border-b border-warning/20 bg-warning-surface px-3 py-1.5 text-2xs text-warning-foreground"
    >
      {props.children}
    </div>
  );
}

export function FileSurfaceLoading(props: { readonly className?: string }) {
  return (
    <div
      role="status"
      aria-label="Loading file"
      className={cn(
        "flex min-h-0 flex-1 items-center justify-center text-muted-foreground",
        props.className,
      )}
    >
      <Spinner size="lg" />
    </div>
  );
}

/**
 * A centered state for a file surface with nothing to show: an empty tree, no
 * search matches, a file without a preview, or a failed read. Same icon disc and
 * title as the browser's empty and unreachable states.
 */
export function FileSurfaceState(props: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly role?: "status" | "alert";
}) {
  return (
    <Empty size="compact" role={props.role ?? "status"} className="min-h-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">{props.icon}</EmptyMedia>
        <EmptyTitle>{props.title}</EmptyTitle>
        {props.description ? (
          <EmptyDescription className="break-words">{props.description}</EmptyDescription>
        ) : null}
      </EmptyHeader>
      {props.action ? <EmptyContent>{props.action}</EmptyContent> : null}
    </Empty>
  );
}

export function FileSurfaceFailure(props: {
  readonly message: ReactNode;
  readonly title?: string;
  readonly onRetry?: () => void;
}) {
  return (
    <FileSurfaceState
      role="alert"
      icon={<FileWarning />}
      title={props.title ?? "Can't open this file"}
      description={props.message}
      action={
        props.onRetry ? (
          <Button type="button" variant="secondary" size="sm" onClick={props.onRetry}>
            <RotateCw />
            Try again
          </Button>
        ) : undefined
      }
    />
  );
}
