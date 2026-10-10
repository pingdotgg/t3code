import type { ContributionStatusTone, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { memo, useMemo } from "react";

import { useThreadContributionStatus } from "../../state/contributionStatus";
import { Badge } from "../ui/badge";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  type ContributionStatusChip,
  contributionStatusChips,
} from "./ThreadContributionStatus.logic";

/** Chips shown inline; the rest are counted in a "+N" badge and listed in the popover. */
const VISIBLE_CHIPS = 2;

const TONE_VARIANT = {
  neutral: "outline",
  info: "info",
  success: "success",
  warning: "warning",
  error: "error",
} as const satisfies Record<ContributionStatusTone, string>;

const TONE_TEXT = {
  neutral: "",
  info: "text-info-foreground",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  error: "text-destructive-foreground",
} as const satisfies Record<ContributionStatusTone, string>;

/**
 * One trigger for every status: the first chips inline, then a "+N" count.
 * Click, tap, Enter or hover opens a list with each status's full text,
 * tooltip and origin, so a truncated or hidden status is always reachable.
 */
function ContributionStatusChips(props: { readonly chips: ReadonlyArray<ContributionStatusChip> }) {
  const { chips } = props;
  const visible = chips.slice(0, VISIBLE_CHIPS);
  const hiddenCount = chips.length - visible.length;
  const origins = [...new Set(chips.map((chip) => chip.origin))];
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        render={
          <button
            type="button"
            aria-label={`Provider status: ${chips.map((chip) => chip.text).join(", ")}`}
            data-thread-contribution-status
            className="relative isolate flex min-w-0 max-w-[45%] shrink cursor-pointer items-center gap-1 rounded-sm outline-none before:pointer-events-none before:absolute before:inset-0 before:z-10 before:rounded-sm focus-visible:before:ring-2 focus-visible:before:ring-inset focus-visible:before:ring-ring pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11"
          />
        }
      >
        {visible.map((chip) => (
          <Badge
            key={chip.id}
            variant={TONE_VARIANT[chip.tone]}
            size="sm"
            className="min-w-0 max-w-48 shrink"
          >
            <span className="truncate">{chip.text}</span>
          </Badge>
        ))}
        {hiddenCount > 0 ? (
          <Badge variant="outline" size="sm">
            +{hiddenCount}
          </Badge>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="start" width="sm" padding="compact">
        <ul className="flex flex-col gap-2 text-xs">
          {chips.map((chip) => (
            <li key={chip.id} className="flex flex-col gap-0.5">
              <span className={`wrap-break-word font-medium ${TONE_TEXT[chip.tone]}`}>
                {chip.text}
              </span>
              {chip.tooltip ? (
                <span className="wrap-break-word text-muted-foreground">{chip.tooltip}</span>
              ) : null}
            </li>
          ))}
        </ul>
        {origins.map((origin) => (
          <p key={origin} className="mt-2 text-muted-foreground text-xs">
            {origin}
          </p>
        ))}
      </PopoverPopup>
    </Popover>
  );
}

/**
 * Advisory statuses a provider (today, Pi extensions) set on the open thread.
 * Renders nothing when there are none or the server predates the channel.
 */
export const ThreadContributionStatus = memo(function ThreadContributionStatus(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const entries = useThreadContributionStatus(props.environmentId, props.threadId);
  const chips = useMemo(() => contributionStatusChips(entries), [entries]);
  if (chips.length === 0) return null;
  return <ContributionStatusChips chips={chips} />;
});
