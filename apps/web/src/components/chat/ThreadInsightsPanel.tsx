import type { ScopedThreadRef, UsageLimitSourceSnapshots } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useAtomValue, RegistryContext } from "@effect/atom-react";
import { useContext, useEffect, useRef } from "react";
import { threadInsightsViewAtom } from "../../state/threadInsights";
import { RefreshCwIcon, ChevronDownIcon } from "lucide-react";
import { useServerConfigs, useThreadShells } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "../ui/collapsible";
import { ThreadDetailsUsage } from "./ThreadDetailsUsage";

const EMPTY_SOURCES: UsageLimitSourceSnapshots = [];
const number = (value: number | null | undefined) =>
  value === null || value === undefined ? "Not reported" : value.toLocaleString();
const dollars = (value: number | null) =>
  value === null
    ? "Unpriced"
    : new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 4,
      }).format(value);

export function ThreadInsightsPanel({
  target,
  section,
}: {
  target: ScopedThreadRef;
  section: "tasks" | "usage";
}) {
  const merged = useAtomValue(threadInsightsViewAtom(scopedThreadKey(target)));
  const registry = useContext(RegistryContext);
  const configs = useServerConfigs();
  const providersByEnvironment = useEnvironmentProviders();
  const shells = useThreadShells();
  const keys = new Set(
    merged.rows.map((row) =>
      scopedThreadKey({ environmentId: row.environmentId, threadId: row.threadId }),
    ),
  );
  const signature = shells
    .filter((shell) =>
      keys.has(scopedThreadKey({ environmentId: shell.environmentId, threadId: shell.id })),
    )
    .map((shell) => `${shell.id}:${shell.updatedAt}`)
    .join("|");
  const previous = useRef(signature);
  const queries = merged.queries;
  const refresh = () => {
    for (const query of queries) registry.refresh(query);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Debounce shell changes into the mounted RPC query cache; no timer survives panel closure.
  useEffect(() => {
    if (previous.current === signature) return;
    const timer = setTimeout(() => {
      previous.current = signature;
      for (const query of queries) registry.refresh(query);
    }, 500);
    return () => clearTimeout(timer);
  }, [signature, queries, registry]);
  return (
    <div className="h-full overflow-y-auto p-4 text-sm">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="font-semibold">Tasks & usage</h2>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh tasks and usage"
          onClick={refresh}
        >
          <RefreshCwIcon />
        </Button>
      </div>
      {merged.errors.map((error) => (
        <p key={error} role="alert" className="mb-2 text-destructive">
          {error}
        </p>
      ))}
      {merged.pending.map((ref) => (
        <p key={scopedThreadKey(ref)} className="mb-2 text-muted-foreground">
          {ref.title}:{" "}
          {configs.get(ref.environmentId)?.threadInsights === true
            ? "Loading or unavailable"
            : "Environment unavailable or server update required"}{" "}
          · not included
        </p>
      ))}
      {merged.truncated ? (
        <p className="mb-2 text-muted-foreground">Partial view: the family limit was reached.</p>
      ) : null}
      {merged.unavailable > 0 ? (
        <p className="mb-2 text-muted-foreground">
          {merged.unavailable} thread records unavailable · not included
        </p>
      ) : null}
      <Collapsible key={`tasks:${section}`} defaultOpen={section === "tasks"}>
        <CollapsibleTrigger className="flex w-full items-center gap-2 py-2 font-medium">
          <ChevronDownIcon className="size-4" />
          Tasks ·{" "}
          {merged.tasks.lists === 0
            ? "No task lists reported"
            : `${merged.tasks.done}/${merged.tasks.total} reported steps`}
        </CollapsibleTrigger>
        <CollapsibleContent>
          {merged.tasks.total > 0 ? (
            <progress
              aria-label="Reported task steps completed"
              value={merged.tasks.done}
              max={merged.tasks.total}
            />
          ) : null}
          <p className="mb-3 text-xs text-muted-foreground">
            Reported steps across this thread and its subagents. Lists may describe overlapping
            work.
          </p>
          {merged.rows.map((row) => (
            <Collapsible
              key={scopedThreadKey({ environmentId: row.environmentId, threadId: row.threadId })}
              defaultOpen={
                row.threadId === target.threadId && row.environmentId === target.environmentId
              }
            >
              <CollapsibleTrigger className="flex w-full items-start gap-2 py-2 text-left">
                <ChevronDownIcon className="mt-0.5 size-3 shrink-0" />
                <span className="min-w-0 flex-1 break-words">
                  {row.title}
                  <span className="block text-xs text-muted-foreground">
                    {row.status} ·{" "}
                    {row.steps === null
                      ? "No task list reported"
                      : `${row.steps.filter((step) => step.status === "completed").length}/${row.steps.length} steps`}
                  </span>
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                {row.steps === null ? (
                  <p className="pb-2 text-xs text-muted-foreground">No task list reported</p>
                ) : row.steps.length === 0 ? (
                  <p className="pb-2 text-xs text-muted-foreground">No steps in this list</p>
                ) : (
                  <ul className="space-y-2 pb-3 ps-5">
                    {row.steps.map((step) => (
                      <li key={step.id} className="flex gap-2">
                        <span aria-label={step.status}>
                          {step.status === "completed"
                            ? "✓"
                            : step.status === "running"
                              ? "◉"
                              : "○"}
                        </span>
                        <span className="break-words">{step.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CollapsibleContent>
            </Collapsible>
          ))}
        </CollapsibleContent>
      </Collapsible>
      <Collapsible key={`usage:${section}`} defaultOpen={section === "usage"}>
        <CollapsibleTrigger className="mt-3 flex w-full items-center gap-2 py-2 font-medium">
          <ChevronDownIcon className="size-4" />
          Usage · {merged.partial ? "Partial recorded usage" : "Recorded usage"}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <dl className="my-3 grid grid-cols-[1fr_auto] gap-2 tabular-nums">
            <dt>Input (includes cache)</dt>
            <dd>{number(merged.inputTokens)}</dd>
            <dt>Cache read</dt>
            <dd>{number(merged.cachedInputTokens)}</dd>
            <dt>Cache write</dt>
            <dd>{number(merged.cacheCreationTokens)}</dd>
            <dt>Output (includes reasoning)</dt>
            <dd>{number(merged.outputTokens)}</dd>
            <dt>API-equivalent estimate</dt>
            <dd>{dollars(merged.costUsd)}</dd>
          </dl>
          <p className="mb-3 text-xs text-muted-foreground">
            Standard-rate estimate, not your subscription bill. Unreported cache tokens are priced
            as uncached input.{" "}
            {merged.unpricedTurns > 0
              ? `${merged.unpricedTurns} turns unpriced or missing a complete breakdown.`
              : ""}
          </p>
          {merged.rows.map((row) => (
            <div
              key={scopedThreadKey({ environmentId: row.environmentId, threadId: row.threadId })}
              className="border-t border-border py-3"
            >
              <p className="break-words font-medium">{row.title}</p>
              <p className="text-xs text-muted-foreground">
                {row.usage.status} · {row.usage.measuredTurns}/{row.usage.turns} turns reported
              </p>
              <p className="mt-1 tabular-nums">
                {number(row.usage.inputTokens)} input · {number(row.usage.outputTokens)} output ·{" "}
                {dollars(row.usage.costUsd)}
              </p>
              {row.usage.hasOtherUsage ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Provider extra usage is not added: it may overlap subagent usage.
                </p>
              ) : null}
            </div>
          ))}
          <p className="mt-4 font-medium">Subscription limits</p>
          <p className="mb-3 text-xs text-muted-foreground">
            Account-wide, across all threads and devices. Per-chat quota: not reported by providers.
          </p>
          {[
            ...new Map(
              merged.rows.flatMap((row) =>
                row.providerInstanceIds.map(
                  (instanceId) =>
                    [
                      `${row.environmentId}:${instanceId}`,
                      { environmentId: row.environmentId, instanceId },
                    ] as const,
                ),
              ),
            ).values(),
          ].map(({ environmentId, instanceId }) => (
            <div key={`${environmentId}:${instanceId}`} className="mb-4">
              <p className="mb-1 text-xs font-medium">
                {providersByEnvironment
                  .get(environmentId)
                  ?.find((provider) => provider.instanceId === instanceId)?.displayName ??
                  instanceId}
              </p>
              <ThreadDetailsUsage
                providerInstanceId={instanceId}
                providers={providersByEnvironment.get(environmentId) ?? []}
                sources={configs.get(environmentId)?.usageLimitSources ?? EMPTY_SOURCES}
              />
            </div>
          ))}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
