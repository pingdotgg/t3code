import type * as kendra from "@distilled.cloud/aws/kendra";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * `PutPrincipalMapping` request with `IndexId` injected from the bound index.
 */
export interface PutPrincipalMappingRequest extends Omit<
  kendra.PutPrincipalMappingRequest,
  "IndexId"
> {}

/**
 * Runtime binding for the `PutPrincipalMapping` operation (IAM action
 * `kendra:PutPrincipalMapping`), scoped to one {@link Index}.
 *
 * Maps users to groups (optionally per data source) so queries filtered
 * on the user's context only return documents that user's groups may
 * access.
 * Provide the implementation with
 * `Effect.provide(AWS.Kendra.PutPrincipalMappingHttp)`.
 *
 * @binding
 * @section Principal Mapping
 * @example Map Users to a Group
 * ```typescript
 * const putPrincipalMapping = yield* AWS.Kendra.PutPrincipalMapping(index);
 *
 * yield* putPrincipalMapping({
 *   GroupId: "engineering",
 *   GroupMembers: {
 *     MemberUsers: [{ UserId: "user@example.com" }],
 *   },
 * });
 * ```
 */
export interface PutPrincipalMapping extends Binding.Service<
  PutPrincipalMapping,
  "AWS.Kendra.PutPrincipalMapping",
  (
    index: Index,
  ) => Effect.Effect<
    (
      request: PutPrincipalMappingRequest,
    ) => Effect.Effect<
      kendra.PutPrincipalMappingResponse,
      kendra.PutPrincipalMappingError
    >
  >
> {}
export const PutPrincipalMapping = Binding.Service<PutPrincipalMapping>(
  "AWS.Kendra.PutPrincipalMapping",
);
