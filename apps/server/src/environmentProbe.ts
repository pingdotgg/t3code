/**
 * "Is a T3 Code server answering at this origin?" — shared by `t3 pair`
 * discovery and by the Tailscale Serve ownership check, which both have to
 * decide whether an endpoint is safe to take over.
 */
import { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

const WELL_KNOWN_ENVIRONMENT_PATH = "/.well-known/t3/environment";
const ENVIRONMENT_PROBE_TIMEOUT = Duration.millis(2_500);

/**
 * Three outcomes, because they drive different decisions: a T3 descriptor
 * (pair with it, or leave its serve mapping alone), nothing answering (safe to
 * configure Tailscale Serve), or something answering that is not a T3 server
 * (do NOT overwrite its mapping).
 */
export type EnvironmentProbeResult =
  | { readonly _tag: "descriptor"; readonly descriptor: ExecutionEnvironmentDescriptor }
  | { readonly _tag: "unreachable" }
  | { readonly _tag: "not-a-t3-server" };

export const probeEnvironmentDescriptor = (
  baseUrl: string,
): Effect.Effect<EnvironmentProbeResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(new URL(WELL_KNOWN_ENVIRONMENT_PATH, baseUrl).toString());
    const response = yield* client.execute(request).pipe(
      Effect.timeout(ENVIRONMENT_PROBE_TIMEOUT),
      // Transport failure or timeout: nothing (reachable) is listening there.
      Effect.mapError(() => ({ _tag: "unreachable" }) as const),
    );
    // Bad-gateway family means a proxy (Tailscale Serve) answered for a
    // backend that is gone — a stale mapping, not a live occupant. Treating
    // it as unreachable lets a server repair its own mapping after the
    // previous owner's port went away.
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      return { _tag: "unreachable" } as const;
    }
    // Anything else that answered HTTP but not with a valid descriptor is
    // some other service.
    const descriptor = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
      Effect.mapError(() => ({ _tag: "not-a-t3-server" }) as const),
    );
    return { _tag: "descriptor", descriptor } as const;
  }).pipe(Effect.catch((outcome) => Effect.succeed(outcome)));
