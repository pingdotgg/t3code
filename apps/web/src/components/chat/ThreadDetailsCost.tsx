import { AuthOrchestrationReadScope, type ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { ChevronDownIcon, InfoIcon } from "lucide-react";

import { useServerConfigs } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { threadInsightsViewAtom } from "../../state/threadInsights";
import { useRightPanelStore } from "../../rightPanelStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

const currency = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
});

export function ThreadDetailsCost({ target }: { readonly target: ScopedThreadRef }) {
  const supported = useServerConfigs().get(target.environmentId)?.threadInsights === true;
  const canRead = useEnvironmentScope(target.environmentId, AuthOrchestrationReadScope);
  return supported && canRead ? (
    <ThreadCost target={target} />
  ) : (
    <CostRow
      value="Unavailable"
      reason={
        supported
          ? "You do not have permission to read this thread's usage."
          : "Connect to an environment that supports thread usage estimates."
      }
    />
  );
}

function ThreadCost({ target }: { readonly target: ScopedThreadRef }) {
  const usage = useAtomValue(threadInsightsViewAtom(scopedThreadKey(target)));
  const partial = usage.partial || usage.unpricedTurns > 0 || usage.errors.length > 0;
  const value =
    usage.costUsd === null
      ? usage.loading
        ? "Calculating…"
        : "Unavailable"
      : `≈ ${currency.format(usage.costUsd)}${partial ? " · partial" : ""}`;
  return (
    <CostRow
      value={value}
      reason={
        usage.errors.length > 0
          ? "Some usage could not be refreshed. The last reported estimate may be incomplete."
          : partial && usage.costUsd !== null
            ? "Some turns or subagents are missing usage or prices."
            : usage.costUsd === null && !usage.loading
              ? "No priced usage has been reported."
              : undefined
      }
      onClick={() => useRightPanelStore.getState().openThreadInsights(target, target, "usage")}
    />
  );
}

function CostRow({
  value,
  reason,
  onClick,
}: {
  readonly value: string;
  readonly reason?: string | undefined;
  readonly onClick?: () => void;
}) {
  return (
    <ThreadDetailsSection
      headingId="thread-details-cost-heading"
      title="Estimated cost"
      showHeading={false}
    >
      <div>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`View estimated cost: ${value}`}
                aria-disabled={onClick === undefined}
                onClick={onClick}
                className="flex h-6 w-full min-w-0 items-center gap-2 rounded-lg px-2.5 text-xs text-foreground/80 outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:hover:bg-white/[0.08]"
              />
            }
          >
            <span className="shrink-0 text-muted-foreground">Est. cost</span>
            <InfoIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            <span className="ml-auto truncate font-medium tabular-nums">{value}</span>
            <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
          </TooltipTrigger>
          <TooltipPopup side="left" sideOffset={16}>
            <div className="flex max-w-64 flex-col gap-0.5">
              <span>API-equivalent estimate, including subagents.</span>
              <span className="text-muted-foreground">
                Standard API rates, not your subscription bill.
              </span>
              {reason ? <span className="text-muted-foreground">{reason}</span> : null}
            </div>
          </TooltipPopup>
        </Tooltip>
      </div>
    </ThreadDetailsSection>
  );
}
