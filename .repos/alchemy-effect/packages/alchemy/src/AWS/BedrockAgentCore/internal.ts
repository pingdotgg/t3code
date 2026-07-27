import * as control from "@distilled.cloud/aws/bedrock-agentcore-control";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import { diffTags } from "../../Tags.ts";

/**
 * Raised when an AgentCore resource lands in a terminal failure state
 * (`FAILED`, `CREATE_FAILED`, `UPDATE_FAILED`) during reconciliation.
 */
export class AgentCoreProvisioningFailed extends Data.TaggedError(
  "AgentCoreProvisioningFailed",
)<{ message: string }> {}

/**
 * Unwrap an AgentCore `SensitiveString` (decoded as `Redacted`) to its plain
 * string value. `String(redacted)` would yield `"<redacted>"`, not the value.
 */
export const unredact = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? Redacted.value(value)
      : value;

/**
 * AgentCore Memory / Runtime / CodeInterpreter / Browser names must match
 * `[a-zA-Z][a-zA-Z0-9_]{0,47}` — underscores, no hyphens. Derive a
 * deterministic physical name and swap hyphens for underscores.
 */
export const createAgentCoreName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 48,
    delimiter: "_",
  });
  return name.replaceAll("-", "_");
});

/**
 * Gateway names must match `([0-9a-zA-Z][-]?){1,48}` — hyphens allowed but
 * never consecutive, no underscores. Collapse runs of hyphens.
 */
export const createGatewayName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({ id, maxLength: 48 });
  return name.replaceAll(/-+/g, "-");
});

/**
 * Read the observed tags of an AgentCore resource by ARN. Best-effort — a
 * failure (e.g. a race with deletion) reports no tags.
 */
export const readAgentCoreTags = Effect.fn(function* (resourceArn: string) {
  const response = yield* control
    .listTagsForResource({ resourceArn })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(response?.tags ?? {})) {
    if (value !== undefined) tags[key] = value;
  }
  return tags;
});

/**
 * Sync tags on an AgentCore resource: diff the OBSERVED cloud tags against
 * the desired set and apply only the delta.
 */
export const syncAgentCoreTags = Effect.fn(function* (
  resourceArn: string,
  desired: Record<string, string>,
) {
  const observed = yield* readAgentCoreTags(resourceArn);
  const { upsert, removed } = diffTags(observed, desired);
  if (upsert.length > 0) {
    yield* control.tagResource({
      resourceArn,
      tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
    });
  }
  if (removed.length > 0) {
    yield* control.untagResource({ resourceArn, tagKeys: removed });
  }
});

/**
 * Bounded retry through transient `ConflictException`s (e.g. deleting a
 * gateway whose targets are still tearing down, or mutating a resource that
 * is mid-transition). Explicitly typed so the conditional `Retry.Return`
 * type never widens the provider layer's requirements in declaration emit.
 */
export const retryWhileConflict = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(15)]),
  });

/**
 * Bounded retry through `ValidationException` during create — a freshly
 * created IAM role referenced by `roleArn` is not instantly assumable by the
 * AgentCore service principal (IAM eventual consistency).
 */
export const retryWhileValidation = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ValidationException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(8)]),
  });
