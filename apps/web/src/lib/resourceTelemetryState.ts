import { AuthDiagnosticsReadScope } from "@t3tools/contracts";
import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";
import type {
  EnvironmentId,
  ResourceTelemetryHistoryInput,
  ResourceTelemetrySnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { msg, useMessages } from "gt-react";

import { m } from "../i18n/messages";
import { usePrimaryEnvironment } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";

export interface ResourceTelemetryState {
  readonly data: ResourceTelemetrySnapshot | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
  readonly retry: () => Promise<ResourceTelemetrySnapshot>;
}

export function useResourceTelemetry(
  targetEnvironmentId?: EnvironmentId | null,
): ResourceTelemetryState {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId =
    targetEnvironmentId === undefined
      ? (primaryEnvironment?.environmentId ?? null)
      : targetEnvironmentId;
  const canReadDiagnostics = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const resolve = useMessages();
  const query = useEnvironmentQuery(
    environmentId === null || !canReadDiagnostics
      ? null
      : serverEnvironment.resourceTelemetry({ environmentId, input: {} }),
    resolve,
  );
  const retryCommand = useAtomCommand(serverEnvironment.retryResourceTelemetry, {
    reportFailure: false,
  });
  const retry = async () => {
    if (environmentId === null) {
      throw new Error(m(msg("No environment is selected.")));
    }
    if (
      !readEnvironmentScope(environmentId, AuthEnvironmentMaintainScope) ||
      !readEnvironmentScope(environmentId, AuthDiagnosticsReadScope)
    ) {
      throw new Error(m(msg("This connection cannot restart the resource monitor.")));
    }
    const result = await retryCommand({ environmentId, input: {} });
    if (result._tag === "Failure") {
      throw Cause.squash(result.cause);
    }
    query.refresh();
    return result.value.snapshot;
  };

  return { ...query, retry };
}

export function useResourceTelemetryHistory(
  input: ResourceTelemetryHistoryInput,
  targetEnvironmentId?: EnvironmentId | null,
) {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId =
    targetEnvironmentId === undefined
      ? (primaryEnvironment?.environmentId ?? null)
      : targetEnvironmentId;
  const canReadDiagnostics = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const resolve = useMessages();
  return useEnvironmentQuery(
    environmentId === null || !canReadDiagnostics
      ? null
      : serverEnvironment.resourceTelemetryHistory({ environmentId, input }),
    resolve,
  );
}
