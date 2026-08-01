import type * as route53 from "@distilled.cloud/aws/route-53";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { HostedZone } from "./HostedZone.ts";

/**
 * `TestDNSAnswer` request with `HostedZoneId` injected from the bound
 * {@link HostedZone}.
 */
export interface TestDNSAnswerRequest extends Omit<
  route53.TestDNSAnswerRequest,
  "HostedZoneId"
> {}

/**
 * Runtime binding for the `TestDNSAnswer` operation (IAM action
 * `route53:TestDNSAnswer`; the action does not support resource-level
 * permissions, so it is granted on `*`).
 *
 * Asks Route 53's authoritative servers what they would answer for a record
 * in the bound {@link HostedZone} — works before (and without) delegation,
 * so it verifies records written via
 * {@link ChangeResourceRecordSets} without waiting for public DNS. Public
 * zones only. Provide the implementation with
 * `Effect.provide(AWS.Route53.TestDNSAnswerHttp)`.
 * @binding
 * @section Inspecting Zones
 * @example Verify a record answers
 * ```typescript
 * const testDnsAnswer = yield* AWS.Route53.TestDNSAnswer(zone);
 *
 * const answer = yield* testDnsAnswer({
 *   RecordName: "www.example.com",
 *   RecordType: "A",
 * });
 * // answer.ResponseCode -> "NOERROR", answer.RecordData -> the values
 * ```
 */
export interface TestDNSAnswer extends Binding.Service<
  TestDNSAnswer,
  "AWS.Route53.TestDNSAnswer",
  (
    zone: HostedZone,
  ) => Effect.Effect<
    (
      request: TestDNSAnswerRequest,
    ) => Effect.Effect<
      route53.TestDNSAnswerResponse,
      route53.TestDNSAnswerError
    >
  >
> {}
export const TestDNSAnswer = Binding.Service<TestDNSAnswer>(
  "AWS.Route53.TestDNSAnswer",
);
