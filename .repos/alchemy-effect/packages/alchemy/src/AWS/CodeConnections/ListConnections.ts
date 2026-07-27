import type * as codeconnections from "@distilled.cloud/aws/codeconnections";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListConnections}.
 */
export interface ListConnectionsRequest
  extends codeconnections.ListConnectionsInput {}

/**
 * Runtime binding for `codeconnections:ListConnections`.
 *
 * An account-level operation (no connection argument) that enumerates the
 * account's connections, optionally filtered by provider type or host.
 * Useful for governance sweeps that audit which source providers are wired
 * up. Provide the implementation with
 * `Effect.provide(AWS.CodeConnections.ListConnectionsHttp)`.
 * @binding
 * @section Inspecting a Connection
 * @example List Connections by Provider
 * ```typescript
 * // init — account-level binding takes no resource
 * const listConnections = yield* AWS.CodeConnections.ListConnections();
 *
 * // runtime
 * const result = yield* listConnections({ ProviderTypeFilter: "GitHub" });
 * const names = (result.Connections ?? []).map((c) => c.ConnectionName);
 * ```
 */
export interface ListConnections extends Binding.Service<
  ListConnections,
  "AWS.CodeConnections.ListConnections",
  () => Effect.Effect<
    (
      request?: ListConnectionsRequest,
    ) => Effect.Effect<
      codeconnections.ListConnectionsOutput,
      codeconnections.ListConnectionsError
    >
  >
> {}

export const ListConnections = Binding.Service<ListConnections>(
  "AWS.CodeConnections.ListConnections",
);
