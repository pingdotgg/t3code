import { useAtomValue } from "@effect/atom-react";
import type { ServerTraceDiagnosticsResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { ensureLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";

const TRACE_DIAGNOSTICS_STALE_TIME_MS = 5_000;
const TRACE_DIAGNOSTICS_IDLE_TTL_MS = 5 * 60_000;

const traceDiagnosticsAtom = Atom.make(
  Effect.promise(() => ensureLocalApi().server.getTraceDiagnostics()),
).pipe(
  Atom.swr({
    staleTime: TRACE_DIAGNOSTICS_STALE_TIME_MS,
    revalidateOnMount: true,
  }),
  Atom.setIdleTTL(TRACE_DIAGNOSTICS_IDLE_TTL_MS),
  Atom.withLabel("trace-diagnostics"),
);

export interface TraceDiagnosticsState {
  readonly data: ServerTraceDiagnosticsResult | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

function formatTraceDiagnosticsError(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to load trace diagnostics.";
}

function readTraceDiagnosticsError(
  result: AsyncResult.AsyncResult<ServerTraceDiagnosticsResult, unknown>,
): string | null {
  if (result._tag !== "Failure") {
    return null;
  }

  const squashed = Cause.squash(result.cause);
  return formatTraceDiagnosticsError(squashed);
}

export function refreshTraceDiagnostics(): void {
  appAtomRegistry.refresh(traceDiagnosticsAtom);
}

export function useTraceDiagnostics(): TraceDiagnosticsState {
  const result = useAtomValue(traceDiagnosticsAtom);
  const data = Option.getOrNull(AsyncResult.value(result));
  const refresh = useCallback(() => {
    refreshTraceDiagnostics();
  }, []);

  return {
    data,
    error: readTraceDiagnosticsError(result),
    isPending: result.waiting,
    refresh,
  };
}
