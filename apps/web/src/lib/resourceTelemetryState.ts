import type {
  EnvironmentId,
  ResourceTelemetryHistoryInput,
  ResourceTelemetrySnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback } from "react";

import { usePrimaryEnvironment } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
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
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.resourceTelemetry({ environmentId, input: {} }),
  );
  const retryCommand = useAtomCommand(serverEnvironment.retryResourceTelemetry, {
    reportFailure: false,
  });
  const retry = useCallback(async () => {
    if (environmentId === null) {
      throw new Error("No environment is selected.");
    }
    const result = await retryCommand({ environmentId, input: {} });
    if (result._tag === "Failure") {
      throw Cause.squash(result.cause);
    }
    return result.value.snapshot;
  }, [environmentId, retryCommand]);

  return { ...query, retry };
}

export function useResourceTelemetryHistory(
  inputOrEnvironmentId: ResourceTelemetryHistoryInput | EnvironmentId | null,
  targetEnvironmentIdOrInput?: EnvironmentId | null | ResourceTelemetryHistoryInput,
) {
  const primaryEnvironment = usePrimaryEnvironment();
  // UNION: base calls as (input, targetEnvironmentId?) while the feature
  // calls as (environmentId, input). Support both orders.
  const isBaseOrder =
    typeof inputOrEnvironmentId === "object" &&
    inputOrEnvironmentId !== null &&
    "windowMs" in (inputOrEnvironmentId as Record<string, unknown>);
  const environmentId: EnvironmentId | null = isBaseOrder
    ? ((targetEnvironmentIdOrInput as EnvironmentId | null | undefined) === undefined
        ? (primaryEnvironment?.environmentId ?? null)
        : (targetEnvironmentIdOrInput as EnvironmentId | null))
    : (inputOrEnvironmentId as EnvironmentId | null);
  const input = (isBaseOrder
    ? (inputOrEnvironmentId as ResourceTelemetryHistoryInput)
    : (targetEnvironmentIdOrInput as ResourceTelemetryHistoryInput));
  return useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.resourceTelemetryHistory({ environmentId, input }),
  );
}
