import * as opensearch from "@distilled.cloud/aws/opensearch";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Convert OpenSearch's `[{ Key, Value }]` tag list into a plain record,
 * dropping any entry missing a key or value.
 */
export const toTagRecord = (
  tags: ReadonlyArray<{ Key?: string; Value?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

/**
 * Read the observed tags for an OpenSearch domain by ARN. A domain that has
 * just been created (or is mid-transition) can transiently reject `listTags`;
 * treat any failure as "no observed tags" so tag reconciliation still runs.
 */
export const readDomainTags = Effect.fn(function* (arn: string) {
  const response = yield* opensearch
    .listTags({ ARN: arn })
    .pipe(Effect.orElseSucceed(() => undefined));
  return toTagRecord(response?.TagList);
});

/**
 * Poll an OpenSearch domain until `done` observes a settled state (bounded:
 * 15s x 120 = ~30 minutes; domain provisioning and blue/green config changes
 * typically take 15-25 minutes). If the schedule exhausts first, the last
 * observation is returned as-is so the caller sees the real (still
 * converging) domain rather than a spurious failure.
 *
 * The explicit `Effect.Effect<A, E, R>` return annotation is load-bearing:
 * inlining repeat/retry combinators in provider lifecycle code lets their
 * conditional return types survive into declaration emit and widen the
 * provider layer to `unknown` R, poisoning `AWS.providers()` downstream.
 */
export const repeatUntilDomainState = <E extends { readonly _tag: string }, R>(
  read: Effect.Effect<opensearch.DomainStatus | undefined, E, R>,
  done: (domain: opensearch.DomainStatus | undefined) => boolean,
): Effect.Effect<opensearch.DomainStatus | undefined, E, R> =>
  Effect.repeat(read, {
    schedule: Schedule.max([Schedule.fixed("15 seconds"), Schedule.recurs(120)]),
    until: done,
  });

/**
 * The domain's search/HTTP endpoint: the public `Endpoint` (IPv4), else the
 * dual-stack `EndpointV2`, else the VPC endpoint from the `Endpoints` map.
 */
export const domainEndpoint = (domain: opensearch.DomainStatus): string | undefined =>
  domain.Endpoint ??
  domain.EndpointV2 ??
  domain.Endpoints?.vpc ??
  Object.values(domain.Endpoints ?? {}).find((value) => value !== undefined);

/**
 * A domain is active once created, no config change is being applied, and
 * its endpoint has been published. `Processing` can flip to `false` before
 * creation has fully finished (`DomainProcessingStatus` still `"Creating"`,
 * no `Endpoint` yet), so the processing status and the endpoint are both
 * required — otherwise the reconciler returns `endpoint: undefined` and every
 * data-plane binding resolves an empty endpoint.
 */
export const isDomainActive = (domain: opensearch.DomainStatus | undefined): boolean =>
  domain === undefined ||
  (domain.Created === true &&
    domain.Processing !== true &&
    domain.Deleted !== true &&
    (domain.DomainProcessingStatus === undefined || domain.DomainProcessingStatus === "Active") &&
    domainEndpoint(domain) !== undefined);

/** A domain can be deleted once it is no longer applying a config change. */
export const isDomainDeletable = (domain: opensearch.DomainStatus | undefined): boolean =>
  domain === undefined || domain.Deleted === true || domain.Processing !== true;
