import { TerminalIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import type { ContextPresentationCapability } from "../contextPresentationRegistry";
import {
  CHAT_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
  CONTEXT_INLINE_CHIP_ICON_TONE_CLASS_NAMES,
  CONTEXT_INLINE_CHIP_INTERACTIVE_CLASS_NAME,
  CONTEXT_INLINE_CHIP_TONE_CLASS_NAMES,
} from "../composerInlineChip";
import { ContextChipPopover, ContextChipShell } from "../contextChipParts";

interface TerminalContextInlineChipProps {
  label: string;
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
  text: string;
  detailsMode: ContextPresentationCapability["details"];
  expired?: boolean;
  surface?: "composer" | "transcript";
}

export function TerminalContextInlineChip(props: TerminalContextInlineChipProps) {
  const { label, terminalLabel, lineStart, lineEnd, text, detailsMode, expired = false } = props;
  const chipClassName =
    props.surface === "transcript" ? CHAT_INLINE_CHIP_CLASS_NAME : COMPOSER_INLINE_CHIP_CLASS_NAME;

  const icon = (
    <TerminalIcon
      className={cn(
        COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
        CONTEXT_INLINE_CHIP_ICON_TONE_CLASS_NAMES.terminal,
        "size-3.5",
        expired && "opacity-100",
      )}
    />
  );

  if (!expired && text.length > 0 && detailsMode === "popover") {
    return (
      <ContextChipPopover
        accessibleLabel={`Terminal excerpt, ${label}`}
        chip={
          <>
            {icon}
            <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{label}</span>
          </>
        }
        triggerClassName={cn(
          chipClassName,
          CONTEXT_INLINE_CHIP_TONE_CLASS_NAMES.terminal,
          CONTEXT_INLINE_CHIP_INTERACTIVE_CLASS_NAME,
          "cursor-pointer",
        )}
        popupClassName="w-[min(40rem,calc(100vw-2rem))]"
        viewportClassName="overflow-hidden p-2"
      >
        <div className="overflow-hidden rounded-md border border-border/70 bg-background/80">
          <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
            <TerminalIcon className="size-4 shrink-0 text-emerald-500" aria-hidden />
            <span className="min-w-0 truncate text-sm font-medium text-foreground">
              {terminalLabel}
            </span>
            <span className="ml-auto shrink-0 text-secondary-label text-xs">
              {lineStart === lineEnd ? `Line ${lineStart}` : `Lines ${lineStart}–${lineEnd}`}
            </span>
          </div>
          <pre
            className="max-h-80 overflow-auto whitespace-pre bg-neutral-950 p-3 font-mono text-neutral-100 text-xs leading-relaxed outline-none [tab-size:4] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/70"
            aria-label="Captured terminal output"
            tabIndex={0}
          >
            {text}
          </pre>
        </div>
      </ContextChipPopover>
    );
  }

  return (
    <ContextChipShell
      icon={icon}
      label={label}
      className={cn(
        chipClassName,
        CONTEXT_INLINE_CHIP_TONE_CLASS_NAMES.terminal,
        expired && "border-destructive/35 bg-destructive/8 text-destructive",
      )}
      labelClassName={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}
      aria-label={`Terminal excerpt, ${label}${expired ? ", expired" : ""}`}
      data-terminal-context-expired={expired ? "true" : undefined}
      tooltipClassName="max-w-80 whitespace-pre-wrap leading-tight"
      tooltip={
        expired
          ? `Terminal context expired. Remove and re-add ${label} to include it in your message.`
          : detailsMode === "none"
            ? undefined
            : text
      }
    />
  );
}
