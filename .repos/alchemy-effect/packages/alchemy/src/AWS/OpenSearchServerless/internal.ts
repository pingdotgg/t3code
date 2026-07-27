import * as aoss from "@distilled.cloud/aws/opensearchserverless";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Raised when a collection (or VPC endpoint) provisioning terminates in a
 * `FAILED` state or never reaches `ACTIVE` within the bounded polling budget.
 */
export class OpenSearchServerlessProvisioningFailed extends Data.TaggedError(
  "OpenSearchServerlessProvisioningFailed",
)<{
  readonly resource: string;
  readonly id: string;
  readonly status: string | undefined;
  readonly failureCode: string | undefined;
  readonly failureMessage: string | undefined;
}> {}

/**
 * Serialize a security/access policy document to the compact JSON string the
 * OpenSearch Serverless API expects. Passing through a string is a no-op so
 * callers may interpolate `Output`-derived collection names into the policy
 * themselves.
 */
export const stringifyPolicy = (
  policy: string | Record<string, unknown> | readonly unknown[],
): string => (typeof policy === "string" ? policy : JSON.stringify(policy));

/**
 * Normalize a policy document (string or object) to a stable JSON string for
 * drift comparison — parse-then-stringify so key ordering differences between
 * the desired document and the API's echoed document do not force a spurious
 * update.
 */
export const canonicalizePolicy = (
  policy: string | Record<string, unknown> | readonly unknown[] | undefined,
): string => {
  if (policy === undefined) {
    return "";
  }
  try {
    const parsed = typeof policy === "string" ? JSON.parse(policy) : policy;
    return JSON.stringify(parsed);
  } catch {
    return typeof policy === "string" ? policy : JSON.stringify(policy);
  }
};

/** Convert the API's `[{ key, value }]` tag list into a plain record. */
export const tagsToRecord = (
  tags: aoss.Tag[] | undefined,
): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((t) => [t.key, t.value]));

/** Convert a plain record into the API's `[{ key, value }]` tag list. */
export const recordToTagList = (tags: Record<string, string>): aoss.Tag[] =>
  Object.entries(tags).map(([key, value]) => ({ key, value }));

/**
 * Poll `batchGetCollection` (bounded, spaced 10s, ~5 min budget) until the
 * collection reaches a terminal status. Explicitly typed so `Effect.repeat`'s
 * conditional return type does not widen the provider layer in declaration
 * emit (see PATTERNS §7).
 */
const untilCollectionTerminal = <E, R>(
  self: Effect.Effect<aoss.BatchGetCollectionResponse, E, R>,
): Effect.Effect<aoss.CollectionDetail | undefined, E, R> =>
  Effect.repeat(
    Effect.map(self, (response) => response.collectionDetails?.[0]),
    {
      schedule: Schedule.spaced("10 seconds"),
      until: (detail) =>
        detail?.status === "ACTIVE" || detail?.status === "FAILED",
      times: 30,
    },
  );

/**
 * Await a collection reaching `ACTIVE`, failing with
 * `OpenSearchServerlessProvisioningFailed` on a `FAILED` terminal status or a
 * budget timeout.
 */
export const awaitCollectionActive = Effect.fn(
  "AWS.OpenSearchServerless.awaitCollectionActive",
)(function* (id: string) {
  const detail = yield* untilCollectionTerminal(
    aoss.batchGetCollection({ ids: [id] }),
  );
  if (detail?.status !== "ACTIVE") {
    return yield* Effect.fail(
      new OpenSearchServerlessProvisioningFailed({
        resource: "Collection",
        id,
        status: detail?.status,
        failureCode: detail?.failureCode,
        failureMessage: detail?.failureMessage,
      }),
    );
  }
  return detail;
});

const untilVpcEndpointTerminal = <E, R>(
  self: Effect.Effect<aoss.BatchGetVpcEndpointResponse, E, R>,
): Effect.Effect<aoss.VpcEndpointDetail | undefined, E, R> =>
  Effect.repeat(
    Effect.map(self, (response) => response.vpcEndpointDetails?.[0]),
    {
      schedule: Schedule.spaced("10 seconds"),
      until: (detail) =>
        detail?.status === "ACTIVE" || detail?.status === "FAILED",
      times: 30,
    },
  );

/**
 * Await a VPC endpoint reaching `ACTIVE`, failing with
 * `OpenSearchServerlessProvisioningFailed` on a `FAILED` terminal status or a
 * budget timeout.
 */
export const awaitVpcEndpointActive = Effect.fn(
  "AWS.OpenSearchServerless.awaitVpcEndpointActive",
)(function* (id: string) {
  const detail = yield* untilVpcEndpointTerminal(
    aoss.batchGetVpcEndpoint({ ids: [id] }),
  );
  if (detail?.status !== "ACTIVE") {
    return yield* Effect.fail(
      new OpenSearchServerlessProvisioningFailed({
        resource: "VpcEndpoint",
        id,
        status: detail?.status,
        failureCode: detail?.failureCode,
        failureMessage: detail?.failureMessage,
      }),
    );
  }
  return detail;
});

/**
 * Bounded retry through the `ConflictException` window that AOSS raises while a
 * dependent resource is still tearing down — e.g. deleting an encryption
 * `SecurityPolicy` while its `Collection` deletion is still propagating.
 * Explicitly typed for the same declaration-emit reason as above.
 */
export const retryWhileConflict = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    // ~3 min budget: a security policy cannot be deleted until every
    // collection it covers is FULLY deleted (not merely DELETING), which can
    // take a couple of minutes after deleteCollection returns.
    schedule: Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(36)]),
  });
