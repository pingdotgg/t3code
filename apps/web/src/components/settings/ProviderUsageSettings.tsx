import type { EnvironmentId } from "@t3tools/contracts";
import {
  aggregateProviderUsage,
  areProviderUsageResultsComplete,
  type EnvironmentUsageInput,
  type ProviderUsageNodeStatus,
} from "@t3tools/client-runtime/provider-usage";
import { GaugeIcon, LoaderCircleIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ProviderUsageDetails,
  ProviderUsageIdentity,
} from "../provider-usage/ProviderUsagePresentation";
import { SettingsPageContainer, SettingsSection, useRelativeTimeTick } from "./settingsLayout";

export function ProviderUsageSettings() {
  const { isReady, environments } = useEnvironments();
  const sortedEnvironments = useMemo(
    () => [...environments].sort((a, b) => a.label.localeCompare(b.label)),
    [environments],
  );
  const [results, setResults] = useState<Record<string, EnvironmentUsageInput>>({});
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const nowMs = useRelativeTimeTick(30_000);

  const handleResult = useCallback((next: EnvironmentUsageInput) => {
    setResults((current) => {
      const previous = current[next.environmentId];
      if (
        previous &&
        previous.snapshots === next.snapshots &&
        previous.isPending === next.isPending &&
        previous.error === next.error &&
        previous.environmentLabel === next.environmentLabel
      ) {
        return current;
      }
      return { ...current, [next.environmentId]: next };
    });
  }, []);

  const handleRemove = useCallback((environmentId: string) => {
    setResults((current) => {
      if (!(environmentId in current)) return current;
      const next = { ...current };
      delete next[environmentId];
      return next;
    });
  }, []);

  const aggregate = useMemo(
    () =>
      aggregateProviderUsage(
        sortedEnvironments.flatMap((environment) => {
          const result = results[environment.environmentId];
          return result ? [result] : [];
        }),
      ),
    [results, sortedEnvironments],
  );

  const handleRefresh = useCallback(() => {
    setRefreshNonce((current) => current + 1);
  }, []);

  useEffect(() => {
    if (refreshNonce === 0) return;
    setIsRefreshing(true);
    const timeout = window.setTimeout(() => setIsRefreshing(false), 1_000);
    return () => window.clearTimeout(timeout);
  }, [refreshNonce]);

  const hasContent =
    aggregate.cards.length > 0 ||
    aggregate.pendingNodes.length > 0 ||
    aggregate.failedNodes.length > 0;
  const hasAllResults = areProviderUsageResultsComplete(
    sortedEnvironments.map((environment) => environment.environmentId),
    results,
  );
  const isInitialLoading =
    isReady && !hasContent && sortedEnvironments.length > 0 && !hasAllResults;
  const newestFetchedAt = aggregate.cards.reduce<string | null>(
    (current, card) => (current === null || card.fetchedAt > current ? card.fetchedAt : current),
    null,
  );

  return (
    <SettingsPageContainer>
      {sortedEnvironments.map((environment) => (
        <EnvironmentUsageProbe
          key={environment.environmentId}
          environmentId={environment.environmentId}
          environmentLabel={environment.label}
          refreshNonce={refreshNonce}
          onResult={handleResult}
          onRemove={handleRemove}
        />
      ))}

      <SettingsSection
        title="Usage & limits"
        headerAction={
          <div className="flex items-center gap-2">
            {newestFetchedAt ? (
              <span className="text-[11px] text-muted-foreground/60">
                Updated {formatRelativeTimeLabel(newestFetchedAt)}
              </span>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    disabled={!isReady || sortedEnvironments.length === 0 || isRefreshing}
                    onClick={handleRefresh}
                    aria-label="Refresh provider usage"
                  >
                    <RefreshCwIcon className={isRefreshing ? "size-3 animate-spin" : "size-3"} />
                  </Button>
                }
              />
              <TooltipPopup side="top">Refresh provider usage</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        {!isReady || isInitialLoading ? (
          <div className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground">
            <LoaderCircleIcon className="size-4 animate-spin" />
            Loading usage…
          </div>
        ) : !hasContent ? (
          <Empty className="min-h-72">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <GaugeIcon />
              </EmptyMedia>
              <EmptyTitle>No usage to show</EmptyTitle>
              <EmptyDescription>
                Connect an environment signed in to a supported provider to see its subscription
                limits here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="divide-y divide-border/60">
            {aggregate.cards.map((card) => (
              <article key={card.key} className="grid gap-5 p-4 sm:p-5">
                <ProviderUsageIdentity usage={card} />
                <ProviderUsageDetails usage={card} nowMs={nowMs} />
                <div className="text-[10px] text-muted-foreground/55">
                  Updated {formatRelativeTimeLabel(card.fetchedAt)}
                </div>
              </article>
            ))}
            {aggregate.pendingNodes.map((node) => (
              <EnvironmentStatusRow key={`pending:${node.environmentId}`} node={node} />
            ))}
            {aggregate.failedNodes.map((node) => (
              <EnvironmentStatusRow key={`failed:${node.environmentId}`} node={node} failed />
            ))}
          </div>
        )}
      </SettingsSection>

      <p className="px-1 text-xs leading-5 text-muted-foreground/65">
        Usage reflects provider subscription rate-limit windows across all connected environments.
        Identical accounts are shown once. Refreshes may use a server-cached snapshot for up to one
        minute.
      </p>
    </SettingsPageContainer>
  );
}

function EnvironmentUsageProbe({
  environmentId,
  environmentLabel,
  refreshNonce,
  onResult,
  onRemove,
}: {
  environmentId: EnvironmentId;
  environmentLabel: string;
  refreshNonce: number;
  onResult: (result: EnvironmentUsageInput) => void;
  onRemove: (environmentId: string) => void;
}) {
  const query = useEnvironmentQuery(serverEnvironment.providerUsage({ environmentId, input: {} }));
  const snapshots = query.data?.usage ?? null;

  useEffect(() => {
    onResult({
      environmentId,
      environmentLabel,
      snapshots,
      isPending: query.isPending,
      error: query.error,
    });
  }, [environmentId, environmentLabel, onResult, query.error, query.isPending, snapshots]);

  useEffect(() => () => onRemove(environmentId), [environmentId, onRemove]);

  const refreshRef = useRef(query.refresh);
  refreshRef.current = query.refresh;
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    refreshRef.current();
  }, [refreshNonce]);

  return null;
}

function EnvironmentStatusRow({
  node,
  failed = false,
}: {
  node: ProviderUsageNodeStatus;
  failed?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
      {failed ? (
        <TriangleAlertIcon className="size-4 shrink-0 text-destructive" />
      ) : (
        <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-foreground">{node.environmentLabel}</div>
        <div
          className={
            failed ? "truncate text-[11px] text-destructive" : "text-[11px] text-muted-foreground"
          }
        >
          {failed ? (node.error ?? "Unreachable") : "Loading usage…"}
        </div>
      </div>
    </div>
  );
}
