import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface InvalidationProps {
  /**
   * Distribution to invalidate.
   */
  distributionId: string;
  /**
   * Version string used as the invalidation caller reference. Change this value
   * to trigger a new invalidation.
   */
  version: string;
  /**
   * Paths to invalidate.
   * @default ["/*"]
   */
  paths?: string[];
  /**
   * Wait for the invalidation to complete.
   * @default false
   */
  wait?: boolean;
}

export interface Invalidation extends Resource<
  "AWS.CloudFront.Invalidation",
  InvalidationProps,
  {
    invalidationId: string;
    distributionId: string;
    version: string;
    status: string;
    paths: string[];
    createTime: Date | undefined;
  },
  never,
  Providers
> {}

/**
 * A CloudFront cache invalidation request.
 *
 * `Invalidation` is a helper resource for website deployments that need to
 * clear selected CloudFront cache paths after asset updates.
 *
 * @section Creating Invalidations
 * @example Invalidate The Entire Distribution
 * ```typescript
 * const invalidation = yield* Invalidation("WebsiteInvalidation", {
 *   distributionId: distribution.distributionId,
 *   version: files.version,
 * });
 * ```
 */
export const Invalidation = Resource<Invalidation>(
  "AWS.CloudFront.Invalidation",
);

const defaultPaths = ["/*"];

class InvalidationInProgress extends Data.TaggedError(
  "InvalidationInProgress",
)<{
  message: string;
}> {}

export const InvalidationProvider = () =>
  Provider.effect(
    Invalidation,
    Effect.gen(function* () {
      const waitForCompletion = Effect.fn(function* (
        distributionId: string,
        invalidationId: string,
      ) {
        yield* Effect.logInfo(
          `CloudFront Invalidation wait: polling ${invalidationId} for distribution ${distributionId}`,
        );
        return yield* cloudfront
          .getInvalidation({
            DistributionId: distributionId,
            Id: invalidationId,
          })
          .pipe(
            Effect.map((response) => response.Invalidation),
            Effect.flatMap((invalidation) =>
              invalidation?.Status === "Completed"
                ? Effect.gen(function* () {
                    yield* Effect.logInfo(
                      `CloudFront Invalidation wait: ${invalidationId} completed`,
                    );
                    return invalidation;
                  })
                : Effect.gen(function* () {
                    yield* Effect.logInfo(
                      `CloudFront Invalidation wait: ${invalidationId} status=${invalidation?.Status ?? "unknown"}`,
                    );
                    return yield* Effect.fail(
                      new InvalidationInProgress({
                        message: `Invalidation ${invalidationId} is still in progress`,
                      }),
                    );
                  }),
            ),
            Effect.retry({
              while: (error) => error._tag === "InvalidationInProgress",
              schedule: Schedule.fixed("2 seconds").pipe(
                Schedule.both(Schedule.recurs(120)),
              ),
            }),
          );
      });

      const createInvalidation = Effect.fn(function* (
        props: InvalidationProps,
      ) {
        yield* Effect.logInfo(
          `CloudFront Invalidation create: distribution=${props.distributionId} version=${props.version} paths=${(props.paths ?? defaultPaths).length} wait=${props.wait ?? false}`,
        );
        const response = yield* cloudfront.createInvalidation({
          DistributionId: props.distributionId,
          InvalidationBatch: {
            CallerReference: props.version,
            Paths: {
              Quantity: (props.paths ?? defaultPaths).length,
              Items: props.paths ?? defaultPaths,
            },
          },
        });

        yield* Effect.logInfo(
          `CloudFront Invalidation create: created ${response.Invalidation?.Id ?? "missing"} status=${response.Invalidation?.Status ?? "unknown"}`,
        );
        const invalidation = props.wait
          ? yield* waitForCompletion(
              props.distributionId,
              response.Invalidation?.Id!,
            )
          : response.Invalidation;

        if (!invalidation?.Id) {
          return yield* Effect.fail(
            new Error("createInvalidation returned no invalidation"),
          );
        }

        return invalidation;
      });

      return {
        stables: ["distributionId", "version"],
        diff: Effect.fn(function* ({ olds, news: _news }) {
          if (!isResolved(_news)) return undefined;
          const news = _news as typeof olds;
          yield* Effect.logInfo(
            `CloudFront Invalidation diff: oldDistribution=${olds.distributionId} newDistribution=${news.distributionId} oldVersion=${olds.version} newVersion=${news.version}`,
          );
          if (
            olds.distributionId !== news.distributionId ||
            olds.version !== news.version
          ) {
            yield* Effect.logInfo(
              `CloudFront Invalidation diff: replacing invalidation for distribution=${news.distributionId}`,
            );
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          // An invalidation is an immutable ledger entry, not a mutable
          // resource. If we already issued one for this logical id and
          // version, return its attributes unchanged. The `diff` above
          // forces a `replace` whenever `distributionId` or `version`
          // changes, so the engine creates a fresh invalidation that way.
          if (output?.invalidationId) {
            yield* session.note(output.invalidationId);
            return output;
          }

          // Ensure — issue the invalidation. CloudFront uses
          // `CallerReference` (= `version`) for idempotency: the same
          // version submitted twice returns the same invalidation.
          const invalidation = yield* createInvalidation(news);
          yield* Effect.logInfo(
            `CloudFront Invalidation reconcile: storing ${invalidation.Id} for distribution=${news.distributionId}`,
          );
          yield* session.note(invalidation.Id);
          return {
            invalidationId: invalidation.Id,
            distributionId: news.distributionId,
            version: news.version,
            status: invalidation.Status ?? "InProgress",
            paths: news.paths ?? defaultPaths,
            createTime: invalidation.CreateTime,
          };
        }),
        delete: Effect.fn(function* () {}),
      };
    }),
  );
