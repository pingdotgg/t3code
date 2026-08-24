import * as agw2 from "@distilled.cloud/aws/apigatewayv2";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Schedule from "effect/Schedule";
import { diffTags, normalizeTags } from "../../Tags.ts";

/**
 * API Gateway v2 ARN helpers. Unlike most services the resource ARNs used
 * for tagging omit the account id (`arn:aws:apigateway:{region}::/apis/{id}`).
 */
export const apiArn = (region: string, apiId: string) =>
  `arn:aws:apigateway:${region}::/apis/${apiId}`;

export const stageArn = (region: string, apiId: string, stageName: string) =>
  `arn:aws:apigateway:${region}::/apis/${apiId}/stages/${stageName}`;

export const domainNameArn = (region: string, domainName: string) =>
  `arn:aws:apigateway:${region}::/domainnames/${domainName}`;

export const vpcLinkArn = (region: string, vpcLinkId: string) =>
  `arn:aws:apigateway:${region}::/vpclinks/${vpcLinkId}`;

/**
 * The `execute-api` ARN that IAM policies (Lambda resource policies,
 * `execute-api:Invoke`/`ManageConnections` statements) use to scope access
 * to an API. Wildcards match across path segments.
 */
export const executeApiArn = (
  region: string,
  accountId: string,
  apiId: string,
  suffix = "/*",
) => `arn:aws:execute-api:${region}:${accountId}:${apiId}${suffix}`;

/**
 * `Create/Update/Delete` operations across API Gateway v2 share an
 * account-wide throttle; parallel test suites and deploys routinely see
 * `TooManyRequestsException` outlast the blanket SDK retry budget. The
 * schedule below (exponential base 1s capped at 20s, 10 attempts, ~60s
 * total) rides out the throttle window without hiding real failures.
 *
 * The helper carries an EXPLICIT return annotation so the conditional type
 * of `Effect.retry` never leaks into declaration emit (which would widen the
 * provider layer to `unknown` for every consumer of `AWS.providers()`).
 */
export const retryOnTooManyRequests = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(effect, {
    while: (error: E) =>
      error._tag === "TooManyRequestsException" ||
      error._tag === "ConflictException",
    schedule: Schedule.max([
      pipe(
        Schedule.exponential(Duration.seconds(1), 2),
        Schedule.modifyDelay(({ duration }) =>
          Effect.succeed(
            Duration.isGreaterThan(duration, Duration.seconds(20))
              ? Duration.seconds(20)
              : duration,
          ),
        ),
      ),
      Schedule.recurs(10),
    ]),
  }) as Effect.Effect<A, E, R>;

/**
 * Normalize the wire tag map (values may be `undefined`) to a plain record.
 */
export const tagRecord = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

/**
 * API Gateway v2 collection operations (`getApis`, `getRoutes`, `getStages`,
 * …) return `{ Items, NextToken }` pages without a Smithy pagination trait,
 * so distilled exposes no `.pages` stream for them. Collect every page
 * manually, bounded at 100 pages so a misbehaving token can never hang the
 * engine.
 */
export const collectAllPages = Effect.fn(function* <A, E, R>(
  fetchPage: (
    nextToken: string | undefined,
  ) => Effect.Effect<{ Items?: readonly A[] | A[]; NextToken?: string }, E, R>,
) {
  const items: A[] = [];
  let nextToken: string | undefined = undefined;
  for (let page = 0; page < 100; page++) {
    const result: { Items?: readonly A[] | A[]; NextToken?: string } =
      yield* fetchPage(nextToken);
    items.push(...(result.Items ?? []));
    nextToken = result.NextToken;
    if (!nextToken) break;
  }
  return items;
});

/**
 * Diff observed tags against desired tags and apply only the delta via the
 * v2 `tagResource`/`untagResource` operations.
 */
export const syncTags = Effect.fn(function* ({
  resourceArn,
  oldTags,
  newTags,
}: {
  resourceArn: string;
  oldTags: Record<string, string>;
  newTags: Record<string, string>;
}) {
  const { removed, upsert } = diffTags(oldTags, newTags);
  if (removed.length > 0) {
    yield* agw2
      .untagResource({ ResourceArn: resourceArn, TagKeys: removed })
      .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
  }
  if (upsert.length > 0) {
    yield* agw2.tagResource({
      ResourceArn: resourceArn,
      Tags: normalizeTags(upsert),
    });
  }
});
