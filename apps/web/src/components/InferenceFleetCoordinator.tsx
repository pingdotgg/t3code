import { useAtomValue } from "@effect/atom-react";
import {
  inferenceFallbackKey,
  inferenceFallbackRetryDelay,
  planInferenceFallbacks,
} from "@t3tools/client-runtime/state/inference-proxy";
import { INFERENCE_DRIVERS } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";

import { useEnvironments, type EnvironmentPresentation } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";

const { inferenceProxy } = serverEnvironment;
const STATUS_REFRESH_INTERVAL_MS = 60_000;

interface Attempt {
  readonly key: string;
  failures: number;
  retryAt: number;
  state: "pending" | "failed" | "succeeded";
}

function Host({
  host,
  consumers,
}: {
  host: EnvironmentPresentation;
  consumers: ReadonlyArray<EnvironmentPresentation>;
}) {
  const canGrant = useAtomValue(inferenceProxy.canGrant(host.environmentId));
  const status = useEnvironmentQuery(
    canGrant
      ? inferenceProxy.inferenceStatus({ environmentId: host.environmentId, input: {} })
      : null,
  );
  const route = useAtomCommand(inferenceProxy.routeInference, { reportFailure: false });
  const providers = useAtomValue(serverEnvironment.providersValueAtom(host.environmentId));
  const providerStatusKey = JSON.stringify(
    providers
      ?.filter((provider) => INFERENCE_DRIVERS.some((driver) => driver === provider.driver))
      .map((provider) => [
        provider.instanceId,
        provider.status,
        provider.auth.status,
        provider.availability,
        provider.limitedUntil,
        provider.checkedAt,
      ]),
  );
  const attempts = useRef(new Map<string, Attempt>());
  const lastProviderStatus = useRef<string | null>(null);
  const candidates = status.data ? planInferenceFallbacks(host, status.data, consumers) : [];
  const keyedCandidates = candidates.map((input) => {
    const consumer = consumers.find(
      (entry) => entry.environmentId === input.consumer.environmentId,
    );
    return {
      input,
      id: `${input.consumer.environmentId}:${input.driver}`,
      key:
        consumer && status.data
          ? inferenceFallbackKey(input.host, consumer, input.driver, status.data)
          : "",
    };
  });
  const key = JSON.stringify([keyedCandidates, status.dataUpdatedAt]);
  const run = useEffectEvent(() => {
    const active = new Set(keyedCandidates.map((candidate) => candidate.id));
    for (const id of attempts.current.keys()) if (!active.has(id)) attempts.current.delete(id);
    for (const { input, id, key: candidateKey } of keyedCandidates) {
      const previous = attempts.current.get(id);
      if (previous?.key === candidateKey) {
        if (previous.state !== "failed" || Date.now() < previous.retryAt) continue;
      }
      const attempt: Attempt = {
        key: candidateKey,
        failures: previous?.key === candidateKey ? previous.failures : 0,
        retryAt: 0,
        state: "pending",
      };
      attempts.current.set(id, attempt);
      void route(input).then((result) => {
        if (attempts.current.get(id) !== attempt) return;
        if (result._tag === "Success") {
          attempt.state = "succeeded";
          return;
        }
        attempt.state = "failed";
        attempt.failures += 1;
        attempt.retryAt = Date.now() + inferenceFallbackRetryDelay(attempt.failures);
      });
    }
  });
  const refreshStatus = useEffectEvent(() => {
    if (canGrant && !status.isPending) status.refresh();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reconciles grants when a connected host or routed consumer changes
  useEffect(() => {
    run();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a refreshed status wakes bounded fallback retries
  }, [key]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- provider auth changes can make a host newly available for fallback
  useEffect(() => {
    if (lastProviderStatus.current !== null && lastProviderStatus.current !== providerStatusKey)
      refreshStatus();
    lastProviderStatus.current = providerStatusKey;
  }, [providerStatusKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hosts can recover without a provider event or connection change
  useEffect(() => {
    if (!canGrant) return;
    const interval = setInterval(refreshStatus, STATUS_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [canGrant]);
  return null;
}

export function InferenceFleetCoordinator() {
  const { environments } = useEnvironments();
  const connected = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities.inferenceProxy === true,
  );
  return connected.map((host) => (
    <Host key={host.environmentId} host={host} consumers={connected} />
  ));
}
