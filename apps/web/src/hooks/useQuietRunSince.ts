import { useAtomValue } from "@effect/atom-react";
import {
  quietRunId,
  quietRunSince,
  type QuietRunThread,
} from "@t3tools/client-runtime/state/thread-execution";
import type { EnvironmentId, RunId } from "@t3tools/contracts";

import { serverEnvironment } from "../state/server";

/** Selects one thread's entry, so a quiet-runs update re-renders only the rows it changes. */
export function useQuietRunSince(
  environmentId: EnvironmentId,
  thread: QuietRunThread | null,
): string | null {
  return useAtomValue(serverEnvironment.configValueAtom(environmentId), (config) =>
    thread === null ? null : quietRunSince(config, thread),
  );
}

/** The quiet run's id, for Stop and Force stop to target it and nothing newer. */
export function useQuietRunId(
  environmentId: EnvironmentId,
  thread: QuietRunThread | null,
): RunId | undefined {
  const runId = useAtomValue(serverEnvironment.configValueAtom(environmentId), (config) =>
    thread === null ? null : quietRunId(config, thread),
  );
  return runId ?? undefined;
}
