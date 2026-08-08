import type { OrchestrationV2HandoffPartKind, ThreadHandoffId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

// Generous next to the snapshot timeout: a chunk is up to a few megabytes and
// may be crossing a home connection, and a transfer that times out mid-part is
// worse than one that takes a while.
const DEFAULT_PART_TIMEOUT_MS = 120_000;

interface PartTarget {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly handoffId: ThreadHandoffId;
  readonly kind: OrchestrationV2HandoffPartKind;
  readonly timeoutMs?: number;
}

const partUrl = (target: PartTarget, suffix: string) =>
  environmentEndpointUrl(
    target.prepared.httpBaseUrl,
    `/api/orchestration/handoffs/${target.handoffId}/parts/${target.kind}${suffix}`,
  );

/** Reads one chunk of a staged part from the environment that holds it. */
export const readHandoffPartChunk = Effect.fn("clientRuntime.state.readHandoffPartChunk")(
  function* (input: PartTarget & { readonly offset: number }) {
    const requestUrl = partUrl(input, "/read");
    const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
    const headers = yield* buildEnvironmentAuthHeaders(
      input.prepared.httpAuthorization,
      "POST",
      requestUrl,
      input.signer,
    );
    return yield* executeEnvironmentHttpRequest(
      requestUrl,
      input.timeoutMs ?? DEFAULT_PART_TIMEOUT_MS,
      withEnvironmentCredentials(
        input.prepared.httpAuthorization,
        client.orchestration.readHandoffPart({
          params: { handoffId: input.handoffId, kind: input.kind },
          payload: { offset: input.offset },
          headers,
        }),
      ),
    );
  },
);

/** Appends one chunk to a staged part on the environment that is receiving it. */
export const writeHandoffPartChunk = Effect.fn("clientRuntime.state.writeHandoffPartChunk")(
  function* (input: PartTarget & { readonly offset: number; readonly data: Uint8Array }) {
    const requestUrl = partUrl(input, "");
    const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
    const headers = yield* buildEnvironmentAuthHeaders(
      input.prepared.httpAuthorization,
      "POST",
      requestUrl,
      input.signer,
    );
    return yield* executeEnvironmentHttpRequest(
      requestUrl,
      input.timeoutMs ?? DEFAULT_PART_TIMEOUT_MS,
      withEnvironmentCredentials(
        input.prepared.httpAuthorization,
        client.orchestration.writeHandoffPart({
          params: { handoffId: input.handoffId, kind: input.kind },
          payload: { offset: input.offset, data: input.data },
          headers,
        }),
      ),
    );
  },
);
