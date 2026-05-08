import { useAtomValue } from "@effect/atom-react";
import type { ServerProcessDiagnosticsResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { ensureLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";

const PROCESS_DIAGNOSTICS_STALE_TIME_MS = 2_000;
const PROCESS_DIAGNOSTICS_IDLE_TTL_MS = 5 * 60_000;

const processDiagnosticsAtom = Atom.make(
  Effect.promise(() => ensureLocalApi().server.getProcessDiagnostics()),
).pipe(
  Atom.swr({
    staleTime: PROCESS_DIAGNOSTICS_STALE_TIME_MS,
    revalidateOnMount: true,
  }),
  Atom.setIdleTTL(PROCESS_DIAGNOSTICS_IDLE_TTL_MS),
  Atom.withLabel("process-diagnostics"),
);

export interface ProcessDiagnosticsState {
  readonly data: ServerProcessDiagnosticsResult | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

function formatProcessDiagnosticsError(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to load process diagnostics.";
}

function readProcessDiagnosticsError(
  result: AsyncResult.AsyncResult<ServerProcessDiagnosticsResult, unknown>,
): string | null {
  if (result._tag !== "Failure") {
    return null;
  }

  const squashed = Cause.squash(result.cause);
  return formatProcessDiagnosticsError(squashed);
}

export function refreshProcessDiagnostics(): void {
  appAtomRegistry.refresh(processDiagnosticsAtom);
}

export function useProcessDiagnostics(): ProcessDiagnosticsState {
  const result = useAtomValue(processDiagnosticsAtom);
  const data = Option.getOrNull(AsyncResult.value(result));
  const refresh = useCallback(() => {
    refreshProcessDiagnostics();
  }, []);

  return {
    data,
    error: readProcessDiagnosticsError(result),
    isPending: result.waiting,
    refresh,
  };
}
