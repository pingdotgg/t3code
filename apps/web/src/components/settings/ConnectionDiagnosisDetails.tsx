import { useAtomValue } from "@effect/atom-react";
import {
  AVAILABLE_CONNECTION_STATE,
  type ConnectionDiagnosis,
  connectionDiagnosisText,
  connectionRoutes,
  hasRelayRoute,
  presentConnectionDiagnosis,
} from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { ChevronRightIcon } from "lucide-react";

import { APP_VERSION } from "~/branding";
import { environmentCatalog } from "~/connection/catalog";
import { type EnvironmentPresentation, useRelayEnvironmentDiscovery } from "~/state/environments";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useDeadlinePassed } from "../../hooks/useDeadline";
import { useNowSecond } from "../../hooks/useNowSecond";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * What failed on the way to an environment, or null while it is connected, off,
 * or has not failed. Reads the supervisor state itself so callers that only need
 * the headline do not re-render on every attempt.
 */
export function useConnectionDiagnosis(environment: EnvironmentPresentation) {
  const environmentId = environment.environmentId;
  const state = AsyncResult.getOrElse(
    useAtomValue(environmentCatalog.stateAtom(environmentId)),
    () => AVAILABLE_CONNECTION_STATE,
  );
  const relayStatus = useRelayEnvironmentDiscovery().environments.get(environmentId)?.status;
  const routes = connectionRoutes(environment.entry);
  const relayOnly = routes.length === 1 && hasRelayRoute(environment.entry);
  const phase = environment.connection.phase;
  const diagnosis =
    environment.entry.enabled && phase !== "connected" && phase !== "unsupported"
      ? presentConnectionDiagnosis({
          hostLabel: environment.label,
          state,
          via: relayOnly ? "relay" : "direct",
          // With a direct route as well, the relay's health says nothing about the route in use.
          relayStatus: relayOnly ? Option.getOrNull(relayStatus ?? Option.none()) : null,
          clientVersion: APP_VERSION,
          serverVersion: environment.serverConfig?.environment.serverVersion,
        })
      : null;
  return { diagnosis, state, relayOnly };
}

/** The failure headline alone, for banners outside Settings. */
export function ConnectionDiagnosisHeadline({
  environment,
}: {
  readonly environment: EnvironmentPresentation;
}) {
  return useConnectionDiagnosis(environment).diagnosis?.headline ?? null;
}

const HOP_MARK = { ok: "✓", failed: "✕", unchecked: "–" } as const;
const HOP_NOTE = { ok: "", failed: "Failed", unchecked: "Not checked" } as const;

/** Ticks once per second, and only while a retry is scheduled, so the list around it does not re-render. */
function RetryCountdown({ retryAt }: { readonly retryAt: number }) {
  return useDeadlinePassed(retryAt) ? "retrying" : <RetryCountdownTicker retryAt={retryAt} />;
}

function RetryCountdownTicker({ retryAt }: { readonly retryAt: number }) {
  const seconds = Math.ceil((retryAt - useNowSecond()) / 1_000);
  return <>{seconds > 0 ? `retrying in ${seconds}s` : "retrying"}</>;
}

/** The collapsed failure: the full headline, then the retry state and a Details toggle. */
export function ConnectionDiagnosisSummary({
  diagnosis,
  retryAt,
  attempt,
  expanded,
  onToggle,
}: {
  readonly diagnosis: ConnectionDiagnosis;
  readonly retryAt: number | null;
  readonly attempt: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <div className="text-xs">
      <p className="text-destructive">{diagnosis.headline}</p>
      <p className="flex flex-wrap items-center gap-1 text-muted-foreground">
        {retryAt !== null ? <RetryCountdown retryAt={retryAt} /> : null}
        {retryAt !== null && attempt > 0 ? <span aria-hidden>·</span> : null}
        {attempt > 0 ? <span>attempt {attempt}</span> : null}
        {retryAt !== null || attempt > 0 ? <span aria-hidden>·</span> : null}
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="inline-flex items-center gap-0.5 rounded-sm outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        >
          Details
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3 transition-transform duration-150 motion-reduce:transition-none",
              expanded && "rotate-90",
            )}
          />
        </button>
      </p>
    </div>
  );
}

/** Hops in order, what to try, the facts, and the actions. */
export function ConnectionDiagnosisPanel({
  hostLabel,
  diagnosis,
  onRetry,
  onAddRoute,
}: {
  readonly hostLabel: string;
  readonly diagnosis: ConnectionDiagnosis;
  readonly onRetry: () => void;
  readonly onAddRoute: (() => void) | null;
}) {
  const { copyToClipboard } = useCopyToClipboard({
    target: "connection diagnostics",
    onCopy: () => toastManager.add({ type: "success", title: "Diagnostics copied" }),
    onError: (error) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy diagnostics",
          description: error.message,
        }),
      ),
  });
  return (
    <div className="mt-2 grid gap-3 border-t border-border/50 pt-2 text-xs">
      <ol className="grid gap-0.5">
        {diagnosis.hops.map((hop) => (
          <li
            key={hop.hop}
            className={cn(
              "flex gap-2",
              hop.result === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            <span aria-hidden className="w-3 text-center">
              {HOP_MARK[hop.result]}
            </span>
            <span className={cn(hop.result === "ok" && "text-foreground")}>{hop.label}</span>
            <span>{HOP_NOTE[hop.result]}</span>
          </li>
        ))}
      </ol>
      <div>
        <p className="font-medium text-foreground">What to try</p>
        <ol className="list-decimal pl-4 text-muted-foreground">
          {diagnosis.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {diagnosis.moreInfoUrl ? (
          <a
            href={diagnosis.moreInfoUrl}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            More info
          </a>
        ) : null}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 font-mono text-muted-foreground">
        {diagnosis.facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt>{label}</dt>
            <dd className="break-all text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="xs" variant="outline" onClick={onRetry}>
          Retry now
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => {
            const text = connectionDiagnosisText(hostLabel, diagnosis);
            copyToClipboard(text, undefined);
          }}
        >
          Copy diagnostics
        </Button>
        {onAddRoute ? (
          <Button type="button" size="xs" variant="outline" onClick={onAddRoute}>
            Add direct route
          </Button>
        ) : null}
      </div>
    </div>
  );
}
