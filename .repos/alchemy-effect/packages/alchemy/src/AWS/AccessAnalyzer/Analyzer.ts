import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  tagRecord,
} from "../../Tags.ts";
import { toWireDays } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";

/**
 * The zone of trust and access type an analyzer monitors.
 *
 * - `ACCOUNT` / `ORGANIZATION` — external-access analysis (the free tier):
 *   surfaces resource policies that grant access to principals outside the
 *   account or organization.
 * - `ACCOUNT_UNUSED_ACCESS` / `ORGANIZATION_UNUSED_ACCESS` — unused-access
 *   analysis (paid): surfaces unused IAM roles, users, and permissions.
 */
export type AnalyzerType =
  | "ACCOUNT"
  | "ORGANIZATION"
  | "ACCOUNT_UNUSED_ACCESS"
  | "ORGANIZATION_UNUSED_ACCESS";

export interface AnalyzerProps {
  /**
   * Name of the analyzer. Must be unique within the account/Region and start
   * with a letter (`[A-Za-z][A-Za-z0-9_.-]*`, up to 255 characters). Changing
   * the name replaces the analyzer.
   * @default a generated physical name derived from the logical ID
   */
  analyzerName?: string;
  /**
   * The analyzer's zone of trust and access type. Create-only — changing the
   * type replaces the analyzer.
   * @default "ACCOUNT"
   */
  type?: AnalyzerType;
  /**
   * How long access must go unused before the analyzer reports it as an
   * unused-access finding. Accepts any duration input (e.g. `"180 days"`);
   * converted to whole days on the wire (valid range 1–365 days). Only valid
   * for `ACCOUNT_UNUSED_ACCESS` / `ORGANIZATION_UNUSED_ACCESS` analyzers.
   * Create-only — the API rejects in-place tracking-period updates, so
   * changing this replaces the analyzer (delete-first, since accounts are
   * limited to one unused-access analyzer per Region). When omitted, the
   * analyzer's existing tracking period is left unmanaged.
   * @default "90 days" (the AWS default)
   */
  unusedAccessAge?: Duration.Input;
  /**
   * Tags to apply to the analyzer. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Analyzer extends Resource<
  "AWS.AccessAnalyzer.Analyzer",
  AnalyzerProps,
  {
    analyzerName: string;
    analyzerArn: string;
    type: string;
    status: string;
  },
  {},
  Providers
> {}

class AnalyzerStillExists extends Data.TaggedError("AnalyzerStillExists")<{
  readonly analyzerName: string;
}> {}

/**
 * An AWS IAM Access Analyzer — continuously monitors resource policies to
 * identify resources shared with an external entity (external-access
 * analyzers) or unused IAM access (unused-access analyzers).
 *
 * The `ACCOUNT` external-access analyzer is free and is the common case:
 * create one per account per Region to have Access Analyzer surface public
 * and cross-account grants as findings.
 * @resource
 * @section Creating an Analyzer
 * @example Account External-Access Analyzer
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const analyzer = yield* AWS.AccessAnalyzer.Analyzer("AccountAnalyzer", {
 *   type: "ACCOUNT",
 * });
 * ```
 *
 * @example Analyzer with Tags
 * ```typescript
 * const analyzer = yield* AWS.AccessAnalyzer.Analyzer("AccountAnalyzer", {
 *   analyzerName: "prod-external-access",
 *   type: "ACCOUNT",
 *   tags: { Environment: "prod" },
 * });
 * ```
 *
 * @example Unused-Access Analyzer with a Custom Tracking Period
 * ```typescript
 * const analyzer = yield* AWS.AccessAnalyzer.Analyzer("UnusedAccess", {
 *   type: "ACCOUNT_UNUSED_ACCESS",
 *   unusedAccessAge: "180 days",
 * });
 * ```
 *
 * @section Archiving Findings
 * @example Auto-archive Findings from a Trusted Account
 * ```typescript
 * const analyzer = yield* AWS.AccessAnalyzer.Analyzer("AccountAnalyzer", {});
 *
 * yield* AWS.AccessAnalyzer.ArchiveRule("TrustedAccount", {
 *   analyzerName: analyzer.analyzerName,
 *   ruleName: "trusted-account",
 *   filter: {
 *     "principal.AWS": { eq: ["123456789012"] },
 *   },
 * });
 * ```
 */
export const Analyzer = Resource<Analyzer>("AWS.AccessAnalyzer.Analyzer");

export const AnalyzerProvider = () =>
  Provider.effect(
    Analyzer,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { analyzerName?: string | undefined },
      ) {
        return (
          props.analyzerName ??
          (yield* createPhysicalName({ id, maxLength: 255 }))
        );
      });

      const observe = Effect.fn(function* (name: string) {
        return yield* aa.getAnalyzer({ analyzerName: name }).pipe(
          Effect.map((r) => r.analyzer),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      });

      return Analyzer.Provider.of({
        stables: ["analyzerName", "analyzerArn", "type"],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* aa.listAnalyzers
              .pages({})
              .pipe(Stream.runCollect);
            const summaries = Array.from(pages).flatMap(
              (page) => page.analyzers ?? [],
            );
            return summaries.map((summary) => ({
              analyzerName: summary.name,
              analyzerArn: summary.arn,
              type: summary.type,
              status: summary.status,
            }));
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.analyzerName ?? (yield* createName(id, olds ?? {}));
          const analyzer = yield* observe(name);
          if (analyzer === undefined) return undefined;
          const attrs = {
            analyzerName: analyzer.name,
            analyzerArn: analyzer.arn,
            type: analyzer.type,
            status: analyzer.status,
          };
          const tags = analyzer.tags ?? {};
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // type is create-only for external-access analyzers
          if ((olds.type ?? "ACCOUNT") !== (news.type ?? "ACCOUNT")) {
            return { action: "replace" } as const;
          }
          // unusedAccessAge is create-only (the API rejects in-place
          // tracking-period updates with "Cannot update unused access age").
          // Delete first: accounts are limited to one unused-access analyzer
          // per Region, so create-before-delete would hit the quota (and the
          // physical name is stable across the replacement).
          if (
            news.unusedAccessAge !== undefined &&
            toWireDays(olds.unusedAccessAge) !==
              toWireDays(news.unusedAccessAge)
          ) {
            return { action: "replace", deleteFirst: true } as const;
          }
          // only tags are mutable → default update path
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.analyzerName ?? (yield* createName(id, news));
          const type = news.type ?? "ACCOUNT";
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const desiredUnusedAccessAge = toWireDays(news.unusedAccessAge);

          // 1. OBSERVE — cloud state is authoritative
          let analyzer = yield* observe(name);

          // 2. ENSURE — createAnalyzer, tolerating a concurrent create race
          if (analyzer === undefined) {
            yield* aa
              .createAnalyzer({
                analyzerName: name,
                type,
                tags: desiredTags,
                configuration:
                  desiredUnusedAccessAge !== undefined
                    ? {
                        unusedAccess: {
                          unusedAccessAge: desiredUnusedAccessAge,
                        },
                      }
                    : undefined,
              })
              .pipe(Effect.catchTag("ConflictException", () => Effect.void));
            analyzer = yield* observe(name);
          }
          if (analyzer === undefined) {
            return yield* Effect.fail(
              new aa.ResourceNotFoundException({
                message: `analyzer ${name} not visible after create`,
                resourceId: name,
                resourceType: "AWS::AccessAnalyzer::Analyzer",
              }),
            );
          }

          // 3. SYNC TAGS — diff against OBSERVED cloud tags
          // (unusedAccessAge is create-only — diff replaces on change, so
          // there is no configuration sync step.)
          const observedTags = tagRecord(analyzer.tags);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* aa.tagResource({
              resourceArn: analyzer.arn,
              tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* aa.untagResource({
              resourceArn: analyzer.arn,
              tagKeys: removed,
            });
          }

          yield* session.note(analyzer.arn);
          return {
            analyzerName: analyzer.name,
            analyzerArn: analyzer.arn,
            type: analyzer.type,
            status: analyzer.status,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* aa
            .deleteAnalyzer({ analyzerName: output.analyzerName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );

          // Unused-access analyzers are account/Region singletons. The delete
          // API returns before the quota slot is necessarily reusable, so a
          // delete-first replacement (or a subsequent clean test run) can hit
          // ServiceQuotaExceededException unless we observe deletion here.
          yield* observe(output.analyzerName).pipe(
            Effect.flatMap((analyzer) =>
              analyzer === undefined
                ? Effect.void
                : Effect.fail(
                    new AnalyzerStillExists({
                      analyzerName: output.analyzerName,
                    }),
                  ),
            ),
            Effect.retry({
              while: (error) => error._tag === "AnalyzerStillExists",
              schedule: Schedule.max([
                Schedule.spaced("2 seconds"),
                Schedule.recurs(15),
              ]),
            }),
          );
        }),
      });
    }),
  );
