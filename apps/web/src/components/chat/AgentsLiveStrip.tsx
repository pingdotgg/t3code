import { memo } from "react";
import type { ThreadAgentSnapshot } from "@t3tools/contracts";
import {
  deriveAgentPanelState,
  formatAgentTokenCount,
} from "@t3tools/client-runtime/state/thread-agents";
import { BotIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "~/lib/utils";

/**
 * Collapsed one-line agent roster shown near the composer while agents are
 * live. Clicking opens the Agents panel — this strip is awareness only.
 */
const AgentsLiveStrip = memo(function AgentsLiveStrip({
  agents,
  onOpen,
}: {
  agents: ReadonlyArray<ThreadAgentSnapshot>;
  onOpen: () => void;
}) {
  const state = deriveAgentPanelState(agents);
  const liveCount = state.runningCount + state.waitingCount;
  if (liveCount === 0) {
    // Parent wrappers must not reserve space when nothing renders (the
    // caller keys visibility off hasLiveAgents with the same derivation).
    return null;
  }

  const runningPhase = state.groups
    .flatMap((group) => group.phases)
    .find((phase) => phase.status === "running");

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex w-full items-center gap-2 rounded-xl border border-border/60 px-3 py-1.5",
        "bg-card/60 text-left text-xs transition-colors hover:border-border hover:bg-card",
      )}
      aria-label={`${liveCount} agents active — open agents panel`}
    >
      <span className="size-1.75 shrink-0 rounded-full bg-sky-500 animate-status-pulse" />
      <BotIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="font-semibold">
        {liveCount} agent{liveCount === 1 ? "" : "s"}
      </span>
      {state.waitingCount > 0 ? (
        <span className="text-warning-foreground">{state.waitingCount} waiting</span>
      ) : null}
      {runningPhase ? (
        <span className="truncate text-muted-foreground">
          {runningPhase.title} ·{" "}
          {
            runningPhase.agents.filter(
              (a) => a.status === "running" || a.status === "pending" || a.status === "waiting",
            ).length
          }{" "}
          active
        </span>
      ) : null}
      <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
        Σ {formatAgentTokenCount(state.totalTokens)}
      </span>
      <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
});

export default AgentsLiveStrip;
