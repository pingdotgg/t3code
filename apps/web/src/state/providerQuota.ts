import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  ProviderDriverKind,
  type ProviderQuotaConsumeResetInput,
  type ProviderQuotaConsumeResetOutcome,
  type ProviderQuotaSummary,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { ServerConfigProjection } from "@t3tools/client-runtime/state/server";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect } from "react";

import { useLiveRefresh } from "../hooks/useLiveRefresh";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "./environments";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

const EMPTY_PROVIDER_QUOTA_ATOM = Atom.make(
  AsyncResult.initial<ProviderQuotaSummary, never>(false),
).pipe(Atom.withLabel("web-provider-quota:empty"));
const EMPTY_SETTINGS_PROJECTION_ATOM = Atom.make(
  AsyncResult.initial<ServerConfigProjection, never>(false),
).pipe(Atom.withLabel("web-provider-quota:settings-projection-empty"));
const PROVIDER_QUOTA_REFRESH_INTERVAL_MS = 30_000;
const PROVIDER_QUOTA_REFRESH_MINIMUM_INTERVAL_MS = 10_000;
const PROVIDER_QUOTA_RECOVERY_INTERVAL_MS = 5_000;
const CODEX_DRIVER = ProviderDriverKind.make("codex");

export interface ProviderQuotaView {
  readonly summary: ProviderQuotaSummary | null;
  readonly isPending: boolean;
  readonly error: string | null;
}

export type ProviderQuotaConsumeResult = AtomCommandResult<
  ProviderQuotaConsumeResetOutcome,
  unknown
>;

function isUnknownProviderQuotaMethod(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("server.getProviderQuota") &&
    (/unknown.*method/i.test(message) || /method.*not found/i.test(message))
  );
}

function providerQuotaError(cause: Cause.Cause<unknown>): string | null {
  const error = Cause.squash(cause);
  if (isUnknownProviderQuotaMethod(error)) return null;
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Provider quota is unavailable.";
}

export function resolveProviderQuotaView(
  result: AsyncResult.AsyncResult<ProviderQuotaSummary, unknown>,
  hasPrimaryEnvironment: boolean,
): ProviderQuotaView {
  return {
    summary: Option.getOrNull(AsyncResult.value(result)),
    isPending: hasPrimaryEnvironment && result.waiting,
    error: result._tag === "Failure" ? providerQuotaError(result.cause) : null,
  };
}

export function refreshProviderQuota(input: {
  readonly environmentId: EnvironmentId;
  readonly refresh: (environmentId: EnvironmentId) => void;
}): void {
  input.refresh(input.environmentId);
}

export async function consumeAndRefreshProviderQuota(input: {
  readonly environmentId: EnvironmentId;
  readonly input: ProviderQuotaConsumeResetInput;
  readonly consume: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: ProviderQuotaConsumeResetInput;
  }) => Promise<ProviderQuotaConsumeResult>;
  readonly refresh: (environmentId: EnvironmentId) => void;
}): Promise<ProviderQuotaConsumeResult> {
  try {
    return await input.consume({
      environmentId: input.environmentId,
      input: input.input,
    });
  } finally {
    refreshProviderQuota(input);
  }
}

export interface PrimaryProviderQuotaState extends ProviderQuotaView {
  readonly refresh: () => void;
  readonly consumeReset: (
    input: ProviderQuotaConsumeResetInput,
  ) => Promise<ProviderQuotaConsumeResult | null>;
}

export function usePrimaryProviderQuota(): PrimaryProviderQuotaState {
  const environmentId = usePrimaryEnvironmentId();
  const quotaAtom =
    environmentId === null
      ? EMPTY_PROVIDER_QUOTA_ATOM
      : serverEnvironment.providerQuota({ environmentId, input: {} });
  const result = useAtomValue(quotaAtom);
  const settingsProjection = useAtomValue(
    environmentId === null
      ? EMPTY_SETTINGS_PROJECTION_ATOM
      : serverEnvironment.configProjection({ environmentId, input: {} }),
  );
  const consume = useAtomCommand(serverEnvironment.consumeProviderQuotaReset, {
    reportFailure: false,
  });
  const refresh = useCallback(() => {
    if (environmentId === null) return;
    refreshProviderQuota({
      environmentId,
      refresh: (exactEnvironmentId) =>
        appAtomRegistry.refresh(
          serverEnvironment.providerQuota({ environmentId: exactEnvironmentId, input: {} }),
        ),
    });
  }, [environmentId]);
  const consumeReset = useCallback(
    (input: ProviderQuotaConsumeResetInput) => {
      if (environmentId === null) return Promise.resolve(null);
      return consumeAndRefreshProviderQuota({
        environmentId,
        input,
        consume,
        refresh: (exactEnvironmentId) =>
          appAtomRegistry.refresh(
            serverEnvironment.providerQuota({ environmentId: exactEnvironmentId, input: {} }),
          ),
      });
    },
    [consume, environmentId],
  );

  const configProjection = Option.getOrNull(AsyncResult.value(settingsProjection));
  const latestConfigEvent = configProjection?.latestEvent;
  useEffect(() => {
    if (latestConfigEvent?.type === "providerStatuses") {
      refresh();
    }
  }, [latestConfigEvent, refresh]);
  const view = resolveProviderQuotaView(result, environmentId !== null);
  const isOlderServerWithoutQuota = result._tag === "Failure" && view.error === null;
  const isMissingEnabledProvider =
    view.summary?.instances.length === 0 &&
    configProjection?.config.providers.some((provider) => provider.enabled) === true;
  const hasUnknownCodexQuota =
    view.summary?.instances.some(
      (instance) => instance.driver === CODEX_DRIVER && instance.status === "unknown",
    ) === true;
  const needsRecovery =
    environmentId !== null &&
    !isOlderServerWithoutQuota &&
    (view.summary === null || isMissingEnabledProvider || hasUnknownCodexQuota);
  useLiveRefresh(refresh, {
    enabled: environmentId !== null,
    ...(environmentId === null ? {} : { key: environmentId }),
    intervalMs: needsRecovery
      ? PROVIDER_QUOTA_RECOVERY_INTERVAL_MS
      : PROVIDER_QUOTA_REFRESH_INTERVAL_MS,
    minimumIntervalMs: needsRecovery
      ? PROVIDER_QUOTA_RECOVERY_INTERVAL_MS
      : PROVIDER_QUOTA_REFRESH_MINIMUM_INTERVAL_MS,
  });

  return {
    ...view,
    refresh,
    consumeReset,
  };
}
