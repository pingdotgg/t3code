import {
  deriveContextUsageTone,
  type ContextWindowSnapshot,
  type ThreadCacheMetrics,
} from "@t3tools/client-runtime/state/context-window";
import { useGT, useLocale, useMessages } from "gt-react";
import { Minimize2Icon, SquarePenIcon } from "lucide-react";
import { memo, useState } from "react";

import { formatContextWindowTokens } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatContextWindowCompactionMessage } from "./compaction.logic";
import { ComposerControl, type ComposerControlSize } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";

function formatCachePercent(rate: number): number {
  return Math.round(Math.max(0, Math.min(1, rate)) * 100);
}

export const ComposerContextMeter = memo(function ComposerContextMeter(props: {
  readonly contextWindow: ContextWindowSnapshot;
  readonly cacheMetrics: ThreadCacheMetrics | null;
  readonly size?: ComposerControlSize;
  readonly compactDisabled: boolean;
  readonly onCompactContext: () => void;
  readonly onStartFreshThread?: (() => void) | undefined;
}) {
  const { contextWindow, cacheMetrics, compactDisabled, onCompactContext, onStartFreshThread } =
    props;
  const size = props.size ?? "sm";
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useState(false);

  const maxTokens =
    contextWindow.maxTokens != null && contextWindow.maxTokens > 0 ? contextWindow.maxTokens : null;
  const usedPercent =
    maxTokens !== null && contextWindow.usedPercentage !== null
      ? Math.round(Math.max(0, Math.min(100, contextWindow.usedPercentage)))
      : null;
  const tone = deriveContextUsageTone({
    usedTokens: contextWindow.usedTokens,
    usedPercentage: usedPercent,
  });
  const usedLabel = formatContextWindowTokens(contextWindow.usedTokens);
  const maxLabel = maxTokens !== null ? formatContextWindowTokens(maxTokens) : null;
  const threadCachePercent =
    cacheMetrics !== null ? formatCachePercent(cacheMetrics.threadHitRate) : null;
  const lastTurnCachePercent =
    cacheMetrics !== null ? formatCachePercent(cacheMetrics.lastTurnHitRate) : null;
  const threshold = contextWindow.autoCompactThreshold ?? null;

  const compactPillLabel =
    threadCachePercent !== null ? `${usedLabel} · ${threadCachePercent}%` : usedLabel;
  const fullPillLabel =
    maxLabel !== null
      ? threadCachePercent !== null
        ? gt("{used} / {max} · {percent}% cache", {
            used: usedLabel,
            max: maxLabel,
            percent: threadCachePercent,
          })
        : `${usedLabel} / ${maxLabel}`
      : threadCachePercent !== null
        ? gt("{used} · {percent}% cache", {
            used: usedLabel,
            percent: threadCachePercent,
          })
        : usedLabel;

  const pillLabel = size === "xs" ? compactPillLabel : fullPillLabel;
  const ariaLabel =
    usedPercent !== null && threadCachePercent !== null
      ? gt("Context {used}% used, {percent}% cache hit", {
          used: usedPercent,
          percent: threadCachePercent,
        })
      : usedPercent !== null
        ? gt("Context: {used}% used", { used: usedPercent })
        : gt("Context: {usedTokens} tokens used", { usedTokens: usedLabel });

  const indicatorDotClass =
    tone === "error" ? "bg-error" : tone === "warning" ? "bg-warning" : "bg-muted-foreground/55";

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  size={size}
                  data-composer-context-meter="true"
                  data-context-tone={tone ?? "normal"}
                  aria-label={ariaLabel}
                  className={cn(
                    "min-w-0 max-w-full gap-1.5 px-2 font-normal text-xs tabular-nums data-popup-open:bg-accent",
                    tone === "error"
                      ? "text-error-foreground hover:text-error-foreground"
                      : tone === "warning"
                        ? "text-warning-foreground hover:text-warning-foreground"
                        : "text-muted-foreground hover:text-foreground",
                  )}
                />
              }
            />
          }
        >
          <span
            aria-hidden="true"
            className={cn("size-1.5 shrink-0 rounded-full", indicatorDotClass)}
          />
          <span data-composer-control-label className="truncate">
            {pillLabel}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top" align="start">
          <div className="flex flex-col gap-0.5 tabular-nums">
            <span className="text-foreground">
              {maxLabel !== null && usedPercent !== null
                ? gt("Context: {used} / {max} ({percent}%)", {
                    used: usedLabel,
                    max: maxLabel,
                    percent: usedPercent,
                  })
                : gt("Context: {usedTokens} tokens used", { usedTokens: usedLabel })}
            </span>
            {maxTokens !== null ? (
              <span className="text-muted-foreground">
                {gt("{used} of {max} tokens", {
                  used: contextWindow.usedTokens.toLocaleString(locale),
                  max: maxTokens.toLocaleString(locale),
                })}
              </span>
            ) : null}
            {cacheMetrics !== null &&
            threadCachePercent !== null &&
            lastTurnCachePercent !== null ? (
              <>
                <span className="text-muted-foreground">
                  {gt("Cache: {thread}% thread · {last}% last turn", {
                    thread: threadCachePercent,
                    last: lastTurnCachePercent,
                  })}
                </span>
                <span className="text-muted-foreground">
                  {gt("Cached: {cached} · Uncached: {uncached}", {
                    cached: formatContextWindowTokens(cacheMetrics.cachedInputTokens),
                    uncached: formatContextWindowTokens(cacheMetrics.uncachedInputTokens),
                  })}
                </span>
              </>
            ) : null}
            {threshold !== null && threshold > 0 ? (
              <span className="text-muted-foreground">
                {formatContextWindowCompactionMessage(threshold, m)}
              </span>
            ) : null}
          </div>
        </TooltipPopup>
      </Tooltip>
      <MenuPopup side="top" align="start" className="min-w-56" {...composerFloatingLayerProps}>
        <div className="flex flex-col gap-1.5 px-2 py-1.5 text-xs tabular-nums">
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium text-muted-foreground">
              {gt("Context", { $context: "context window row label" })}
            </span>
            <span
              className={cn(
                "font-medium",
                tone === "error"
                  ? "text-error-foreground"
                  : tone === "warning"
                    ? "text-warning-foreground"
                    : "text-foreground",
              )}
            >
              {maxLabel !== null && usedPercent !== null
                ? `${usedLabel} / ${maxLabel} (${usedPercent}%)`
                : usedLabel}
            </span>
          </div>
          {usedPercent !== null ? (
            <div className="relative h-1 w-full overflow-hidden rounded-full bg-muted-foreground/20">
              {usedPercent > 0 ? (
                <span
                  className={cn(
                    "absolute inset-y-0 left-0 rounded-full",
                    tone === "error"
                      ? "bg-error"
                      : tone === "warning"
                        ? "bg-warning"
                        : "bg-foreground/70",
                  )}
                  style={{ width: `max(${usedPercent}%, 6px)` }}
                />
              ) : null}
            </div>
          ) : null}
          {cacheMetrics !== null && threadCachePercent !== null && lastTurnCachePercent !== null ? (
            <div className="flex flex-col gap-0.5 text-muted-foreground">
              <span>
                {gt("Cache: {thread}% thread · {last}% last turn", {
                  thread: threadCachePercent,
                  last: lastTurnCachePercent,
                })}
              </span>
              <span>
                {gt("Cached: {cached} · Uncached: {uncached}", {
                  cached: formatContextWindowTokens(cacheMetrics.cachedInputTokens),
                  uncached: formatContextWindowTokens(cacheMetrics.uncachedInputTokens),
                })}
              </span>
            </div>
          ) : null}
        </div>
        <MenuSeparator />
        <MenuItem
          disabled={compactDisabled}
          onClick={() => {
            setOpen(false);
            onCompactContext();
          }}
        >
          <Minimize2Icon aria-hidden="true" />
          <span>{gt("Compact context")}</span>
        </MenuItem>
        {onStartFreshThread ? (
          <MenuItem
            onClick={() => {
              setOpen(false);
              onStartFreshThread();
            }}
          >
            <SquarePenIcon aria-hidden="true" />
            <span>{gt("Start fresh thread")}</span>
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
