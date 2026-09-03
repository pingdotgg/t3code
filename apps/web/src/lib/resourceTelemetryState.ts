import type {
  EnvironmentId,
  ResourceTelemetryHistoryInput,
  ResourceTelemetrySnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback } from "react";

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

export function useResourceTelemetry(environmentId: EnvironmentId | null): ResourceTelemetryState {
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
  environmentId: EnvironmentId | null,
  input: ResourceTelemetryHistoryInput,
) {
  return useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.resourceTelemetryHistory({ environmentId, input }),
  );
}
