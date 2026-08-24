import type * as organizations from "@distilled.cloud/aws/organizations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `organizations:DescribeHandshake`.
 *
 * Returns the details and current state of a handshake — accepted, declined, or canceled handshakes stay readable for 30 days.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.DescribeHandshakeHttp)`.
 * @binding
 * @section Handshakes & Invitations
 * @example Read a Handshake
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeHandshake = yield* AWS.Organizations.DescribeHandshake();
 *
 * // runtime
 * const { Handshake } = yield* describeHandshake({ HandshakeId: handshakeId });
 * ```
 */
export interface DescribeHandshake extends Binding.Service<
  DescribeHandshake,
  "AWS.Organizations.DescribeHandshake",
  () => Effect.Effect<
    (
      request: organizations.DescribeHandshakeRequest,
    ) => Effect.Effect<
      organizations.DescribeHandshakeResponse,
      organizations.DescribeHandshakeError
    >
  >
> {}
export const DescribeHandshake = Binding.Service<DescribeHandshake>(
  "AWS.Organizations.DescribeHandshake",
);
