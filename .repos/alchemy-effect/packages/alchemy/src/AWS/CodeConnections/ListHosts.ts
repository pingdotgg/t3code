import type * as codeconnections from "@distilled.cloud/aws/codeconnections";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListHosts}.
 */
export interface ListHostsRequest extends codeconnections.ListHostsInput {}

/**
 * Runtime binding for `codeconnections:ListHosts`.
 *
 * An account-level operation (no host argument) that enumerates the
 * account's hosts — the self-managed provider endpoints (GitHub Enterprise
 * Server, GitLab self-managed) that connections attach to. Useful for
 * governance sweeps that audit which provider endpoints are registered.
 * Provide the implementation with
 * `Effect.provide(AWS.CodeConnections.ListHostsHttp)`.
 * @binding
 * @section Inspecting a Host
 * @example List the Account's Hosts
 * ```typescript
 * // init — account-level binding takes no resource
 * const listHosts = yield* AWS.CodeConnections.ListHosts();
 *
 * // runtime
 * const result = yield* listHosts();
 * const urls = (result.Hosts ?? []).map((h) => h.ProviderEndpoint);
 * ```
 */
export interface ListHosts extends Binding.Service<
  ListHosts,
  "AWS.CodeConnections.ListHosts",
  () => Effect.Effect<
    (
      request?: ListHostsRequest,
    ) => Effect.Effect<
      codeconnections.ListHostsOutput,
      codeconnections.ListHostsError
    >
  >
> {}

export const ListHosts = Binding.Service<ListHosts>(
  "AWS.CodeConnections.ListHosts",
);
