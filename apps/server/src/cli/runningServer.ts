import { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import type { PersistedServerRuntimeState } from "../serverRuntimeState.ts";

const WELL_KNOWN_ENVIRONMENT_PATH = "/.well-known/t3/environment";
const SERVER_PROBE_TIMEOUT = Duration.millis(2_500);

/** Distinguishes a live T3 server from a dead origin or an unrelated responder. */
export type EnvironmentProbeResult =
  | { readonly _tag: "descriptor"; readonly descriptor: ExecutionEnvironmentDescriptor }
  | { readonly _tag: "unreachable" }
  | { readonly _tag: "not-a-t3-server" };

export const probeEnvironmentDescriptor = Effect.fn("runningServer.probeEnvironmentDescriptor")(
  function* (baseUrl: string) {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(new URL(WELL_KNOWN_ENVIRONMENT_PATH, baseUrl).toString());
    const response = yield* client.execute(request).pipe(
      Effect.timeout(SERVER_PROBE_TIMEOUT),
      Effect.mapError(() => ({ _tag: "unreachable" }) as const),
    );
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      return { _tag: "unreachable" } as const;
    }
    const descriptor = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
      Effect.mapError(() => ({ _tag: "not-a-t3-server" }) as const),
    );
    return { _tag: "descriptor", descriptor } as const;
  },
  Effect.catch((outcome) => Effect.succeed(outcome)),
);

// Signal 0 delivers nothing; EPERM still proves that the process exists.
export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

/** Reject stale runtime files before callers open auth storage or mint credentials. */
export const isLivePersistedServerRuntimeState = Effect.fn(
  "runningServer.isLivePersistedServerRuntimeState",
)(function* (state: PersistedServerRuntimeState) {
  if (!isProcessAlive(state.pid)) return false;
  const probe = yield* probeEnvironmentDescriptor(state.origin);
  return probe._tag === "descriptor";
});
