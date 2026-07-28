import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

/**
 * A single filter criterion evaluated against a finding attribute. Provide at
 * least one comparison; multiple comparisons on one criterion are ANDed.
 */
export interface ArchiveRuleCriterion {
  /** The attribute value must equal one of these values. */
  eq?: string[];
  /** The attribute value must not equal any of these values. */
  neq?: string[];
  /** The attribute value must contain one of these substrings. */
  contains?: string[];
  /** The attribute must (or must not) be present. */
  exists?: boolean;
}

export interface ArchiveRuleProps {
  /**
   * The name of the analyzer the rule belongs to. Changing the analyzer
   * replaces the rule.
   */
  analyzerName: string;
  /**
   * The name of the archive rule, unique within the analyzer. Changing the
   * name replaces the rule.
   */
  ruleName: string;
  /**
   * The filter criteria keyed by finding attribute (e.g. `principal.AWS`,
   * `resource`, `condition.aws:PrincipalOrgID`, `isPublic`). New findings
   * matching every criterion are automatically archived. Mutable — changing
   * the filter updates the rule in place.
   */
  filter: Record<string, ArchiveRuleCriterion>;
}

export interface ArchiveRule extends Resource<
  "AWS.AccessAnalyzer.ArchiveRule",
  ArchiveRuleProps,
  {
    analyzerName: string;
    ruleName: string;
  },
  {},
  Providers
> {}

/**
 * An archive rule for an IAM Access Analyzer — automatically archives new
 * findings that match the filter criteria, so expected cross-account or
 * public grants don't clutter the active findings list.
 *
 * Archive rules apply only to findings created after the rule; existing
 * findings are unaffected.
 * @resource
 * @section Creating Archive Rules
 * @example Archive Findings from a Trusted Account
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
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
 *
 * @example Archive Public S3 Findings
 * ```typescript
 * yield* AWS.AccessAnalyzer.ArchiveRule("PublicBuckets", {
 *   analyzerName: analyzer.analyzerName,
 *   ruleName: "public-buckets",
 *   filter: {
 *     resourceType: { eq: ["AWS::S3::Bucket"] },
 *     isPublic: { eq: ["true"] },
 *   },
 * });
 * ```
 */
export const ArchiveRule = Resource<ArchiveRule>(
  "AWS.AccessAnalyzer.ArchiveRule",
);

export const ArchiveRuleProvider = () =>
  Provider.effect(
    ArchiveRule,
    Effect.gen(function* () {
      const toFilter = (filter: Record<string, ArchiveRuleCriterion>) =>
        Object.fromEntries(
          Object.entries(filter).map(([key, criterion]) => [
            key,
            {
              eq: criterion.eq,
              neq: criterion.neq,
              contains: criterion.contains,
              exists: criterion.exists,
            },
          ]),
        );

      const observe = Effect.fn(function* (
        analyzerName: string,
        ruleName: string,
      ) {
        return yield* aa.getArchiveRule({ analyzerName, ruleName }).pipe(
          Effect.map((r) => r.archiveRule),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      });

      return ArchiveRule.Provider.of({
        stables: ["analyzerName", "ruleName"],

        // sub-resource keyed by parent analyzer + rule name — not enumerable
        // account-wide without the parent
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ olds, output }) {
          const analyzerName = output?.analyzerName ?? olds?.analyzerName;
          const ruleName = output?.ruleName ?? olds?.ruleName;
          if (analyzerName === undefined || ruleName === undefined) {
            return undefined;
          }
          const rule = yield* observe(analyzerName, ruleName);
          if (rule === undefined) return undefined;
          return { analyzerName, ruleName: rule.ruleName };
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (olds.analyzerName !== news.analyzerName) {
            return { action: "replace" } as const;
          }
          if (olds.ruleName !== news.ruleName) {
            return { action: "replace" } as const;
          }
          // filter is mutable → default update path
        }),

        reconcile: Effect.fn(function* ({ news, output, session }) {
          const filter = toFilter(news.filter);

          // 1. OBSERVE — cloud state is authoritative
          const existing = yield* observe(news.analyzerName, news.ruleName);

          // 2. ENSURE / SYNC — createArchiveRule for a new rule, otherwise
          //    updateArchiveRule to converge the filter. Both are idempotent.
          if (existing === undefined) {
            yield* aa
              .createArchiveRule({
                analyzerName: news.analyzerName,
                ruleName: news.ruleName,
                filter,
              })
              .pipe(
                // a concurrent create — fall through to update the filter
                Effect.catchTag("ConflictException", () =>
                  aa.updateArchiveRule({
                    analyzerName: news.analyzerName,
                    ruleName: news.ruleName,
                    filter,
                  }),
                ),
              );
          } else {
            yield* aa.updateArchiveRule({
              analyzerName: news.analyzerName,
              ruleName: news.ruleName,
              filter,
            });
          }

          yield* session.note(news.ruleName);
          return {
            analyzerName: news.analyzerName,
            ruleName: news.ruleName,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* aa
            .deleteArchiveRule({
              analyzerName: output.analyzerName,
              ruleName: output.ruleName,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
