import type * as WAFV2 from "@distilled.cloud/aws/wafv2";
import * as wafv2 from "@distilled.cloud/aws/wafv2";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  hasAlchemyTags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  fetchWafTags,
  retryAssociatedItem,
  retryOptimisticLock,
  syncWafTags,
  type WafScope,
  withWafScope,
} from "./internal.ts";

export interface RegexPatternSetProps {
  /**
   * Name of the regex pattern set. Must match `^[\w\-]+$` and be 1-128
   * characters. Changing the name replaces the regex pattern set.
   * @default a physical name derived from the app, stage and logical ID
   */
  regexPatternSetName?: string;
  /**
   * Scope of the regex pattern set — `REGIONAL` (ambient region) or
   * `CLOUDFRONT` (pinned to `us-east-1`). Must match the scope of the web
   * ACLs and rule groups that reference it. Changing the scope replaces the
   * regex pattern set.
   * @default "REGIONAL"
   */
  scope?: WafScope;
  /**
   * Regular expressions in the set (1-10 patterns, each up to 200
   * characters). Mutable — updated in place.
   */
  regularExpressions: string[];
  /**
   * Description of the regex pattern set.
   */
  description?: string;
  /**
   * User-defined tags to apply to the regex pattern set.
   */
  tags?: Record<string, string>;
}

export interface RegexPatternSet extends Resource<
  "AWS.WAFv2.RegexPatternSet",
  RegexPatternSetProps,
  {
    /**
     * Name of the regex pattern set.
     */
    regexPatternSetName: string;
    /**
     * WAF-assigned unique ID of the regex pattern set.
     */
    regexPatternSetId: string;
    /**
     * ARN of the regex pattern set — reference it from a rule's
     * `RegexPatternSetReferenceStatement`.
     */
    regexPatternSetArn: string;
    /**
     * Scope the regex pattern set was created in.
     */
    scope: WafScope;
    /**
     * Current regular expressions in the set.
     */
    regularExpressions: string[];
  },
  never,
  Providers
> {}

/**
 * An AWS WAFv2 regex pattern set — a named collection of regular expressions
 * referenced from web ACL and rule group rules via
 * `RegexPatternSetReferenceStatement`.
 *
 * @resource
 * @section Creating Regex Pattern Sets
 * @example Block Requests Matching Bad Path Patterns
 * ```typescript
 * const badPaths = yield* AWS.WAFv2.RegexPatternSet("BadPaths", {
 *   regularExpressions: ["^/wp-admin", "\\.php$"],
 * });
 * ```
 *
 * @example Reference from a Web ACL Rule
 * ```typescript
 * const acl = yield* AWS.WAFv2.WebACL("Firewall", {
 *   rules: [
 *     {
 *       Name: "block-bad-paths",
 *       Priority: 0,
 *       Statement: {
 *         RegexPatternSetReferenceStatement: {
 *           ARN: badPaths.regexPatternSetArn,
 *           FieldToMatch: { UriPath: {} },
 *           TextTransformations: [{ Priority: 0, Type: "NONE" }],
 *         },
 *       },
 *       Action: { Block: {} },
 *       VisibilityConfig: {
 *         SampledRequestsEnabled: true,
 *         CloudWatchMetricsEnabled: true,
 *         MetricName: "block-bad-paths",
 *       },
 *     },
 *   ],
 * });
 * ```
 */
export const RegexPatternSet = Resource<RegexPatternSet>(
  "AWS.WAFv2.RegexPatternSet",
);

const defaultScope: WafScope = "REGIONAL";

const toExpressionList = (expressions: readonly string[]): WAFV2.Regex[] =>
  expressions.map((RegexString) => ({ RegexString }));

const fromExpressionList = (
  list: readonly WAFV2.Regex[] | undefined,
): string[] =>
  (list ?? []).flatMap((regex) =>
    regex.RegexString !== undefined ? [regex.RegexString] : [],
  );

const sorted = (values: readonly string[]) =>
  [...values].sort((a, b) => a.localeCompare(b));

const toAttrs = (set: WAFV2.RegexPatternSet, scope: WafScope) => ({
  regexPatternSetName: set.Name ?? "",
  regexPatternSetId: set.Id ?? "",
  regexPatternSetArn: set.ARN ?? "",
  scope,
  regularExpressions: fromExpressionList(set.RegularExpressionList),
});

export const RegexPatternSetProvider = () =>
  Provider.effect(
    RegexPatternSet,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: RegexPatternSetProps,
      ) {
        return (
          props.regexPatternSetName ??
          (yield* createPhysicalName({ id, maxLength: 128 }))
        );
      });

      const findSet = Effect.fn(function* (
        scope: WafScope,
        name: string,
        cachedId: string | undefined,
      ) {
        if (cachedId !== undefined) {
          const byId = yield* withWafScope(
            scope,
            wafv2
              .getRegexPatternSet({ Name: name, Scope: scope, Id: cachedId })
              .pipe(
                Effect.catchTag("WAFNonexistentItemException", () =>
                  Effect.succeed(undefined),
                ),
              ),
          );
          if (byId?.RegexPatternSet) {
            return byId;
          }
        }
        let marker: string | undefined;
        for (let page = 0; page < 20; page++) {
          const listed = yield* withWafScope(
            scope,
            wafv2.listRegexPatternSets({
              Scope: scope,
              NextMarker: marker,
              Limit: 100,
            }),
          );
          const summary = listed.RegexPatternSets?.find((s) => s.Name === name);
          if (summary?.Id !== undefined) {
            return yield* withWafScope(
              scope,
              wafv2
                .getRegexPatternSet({
                  Name: name,
                  Scope: scope,
                  Id: summary.Id,
                })
                .pipe(
                  Effect.catchTag("WAFNonexistentItemException", () =>
                    Effect.succeed(undefined),
                  ),
                ),
            );
          }
          if (
            !listed.NextMarker ||
            (listed.RegexPatternSets?.length ?? 0) === 0
          ) {
            break;
          }
          marker = listed.NextMarker;
        }
        return undefined;
      });

      const listScope = Effect.fn(function* (scope: WafScope) {
        const rows: ReturnType<typeof toAttrs>[] = [];
        let marker: string | undefined;
        for (let page = 0; page < 50; page++) {
          const listed = yield* withWafScope(
            scope,
            wafv2.listRegexPatternSets({
              Scope: scope,
              NextMarker: marker,
              Limit: 100,
            }),
          );
          const summaries = listed.RegexPatternSets ?? [];
          const details = yield* Effect.forEach(
            summaries,
            (summary) =>
              summary.Name !== undefined && summary.Id !== undefined
                ? withWafScope(
                    scope,
                    wafv2
                      .getRegexPatternSet({
                        Name: summary.Name,
                        Scope: scope,
                        Id: summary.Id,
                      })
                      .pipe(
                        Effect.catchTag("WAFNonexistentItemException", () =>
                          Effect.succeed(undefined),
                        ),
                      ),
                  )
                : Effect.succeed(undefined),
            { concurrency: 5 },
          );
          for (const detail of details) {
            if (detail?.RegexPatternSet) {
              rows.push(toAttrs(detail.RegexPatternSet, scope));
            }
          }
          if (!listed.NextMarker || summaries.length === 0) {
            break;
          }
          marker = listed.NextMarker;
        }
        return rows;
      });

      return {
        stables: [
          "regexPatternSetName",
          "regexPatternSetId",
          "regexPatternSetArn",
          "scope",
        ],

        list: () =>
          Effect.gen(function* () {
            const regional = yield* listScope("REGIONAL");
            const cloudfront = yield* listScope("CLOUDFRONT");
            return [...regional, ...cloudfront];
          }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(
            id,
            olds ?? { regularExpressions: [] },
          );
          const newName = yield* createName(id, news);
          if (
            oldName !== newName ||
            (olds?.scope ?? defaultScope) !== (news.scope ?? defaultScope)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const scope = output?.scope ?? olds?.scope ?? defaultScope;
          const name =
            output?.regexPatternSetName ??
            (yield* createName(id, olds ?? { regularExpressions: [] }));
          const found = yield* findSet(scope, name, output?.regexPatternSetId);
          if (!found?.RegexPatternSet?.ARN) {
            return undefined;
          }
          const attrs = toAttrs(found.RegexPatternSet, scope);
          const tags = yield* fetchWafTags(scope, found.RegexPatternSet.ARN);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const scope = news.scope ?? defaultScope;
          const name =
            output?.regexPatternSetName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. Observe.
          let observed = yield* findSet(scope, name, output?.regexPatternSetId);

          // 2. Ensure — tolerate a duplicate-create race and re-read.
          if (!observed?.RegexPatternSet) {
            yield* withWafScope(
              scope,
              wafv2
                .createRegexPatternSet({
                  Name: name,
                  Scope: scope,
                  RegularExpressionList: toExpressionList(
                    news.regularExpressions,
                  ),
                  Description: news.description,
                  Tags: createTagsList(desiredTags),
                })
                .pipe(
                  Effect.catchTag("WAFDuplicateItemException", () =>
                    Effect.succeed(undefined),
                  ),
                ),
            );
            observed = yield* findSet(scope, name, undefined);
          }

          const set = observed?.RegexPatternSet;
          const arn = set?.ARN;
          if (set === undefined || arn === undefined) {
            return yield* Effect.fail(
              new Error(
                `Failed to observe RegexPatternSet '${name}' after create`,
              ),
            );
          }

          yield* session.note(arn);

          // 3. Sync expressions + description against OBSERVED state. WAF
          //    may return the list in arbitrary order — compare as sets.
          const drifted = !deepEqual(
            {
              RegularExpressions: sorted(
                fromExpressionList(set.RegularExpressionList),
              ),
              Description: set.Description,
            },
            {
              RegularExpressions: sorted(news.regularExpressions),
              Description: news.description,
            },
            { stripNullish: true },
          );
          if (drifted) {
            yield* retryOptimisticLock(
              Effect.gen(function* () {
                const fresh = yield* findSet(scope, name, set.Id);
                if (
                  !fresh?.RegexPatternSet?.Id ||
                  fresh.LockToken === undefined
                ) {
                  return;
                }
                yield* withWafScope(
                  scope,
                  wafv2.updateRegexPatternSet({
                    Name: name,
                    Scope: scope,
                    Id: fresh.RegexPatternSet.Id,
                    RegularExpressionList: toExpressionList(
                      news.regularExpressions,
                    ),
                    Description: news.description,
                    LockToken: fresh.LockToken,
                  }),
                );
              }),
            );
          }

          // 3b. Sync tags against OBSERVED cloud tags.
          yield* syncWafTags(scope, arn, desiredTags);

          // 4. Return fresh attributes.
          return {
            ...toAttrs(set, scope),
            regularExpressions: [...news.regularExpressions],
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          const scope = output.scope;
          // A pattern set still referenced by a web ACL rule (deletion
          // propagation) surfaces WAFAssociatedItemException — retry it.
          yield* retryAssociatedItem(
            retryOptimisticLock(
              Effect.gen(function* () {
                const found = yield* withWafScope(
                  scope,
                  wafv2
                    .getRegexPatternSet({
                      Name: output.regexPatternSetName,
                      Scope: scope,
                      Id: output.regexPatternSetId,
                    })
                    .pipe(
                      Effect.catchTag("WAFNonexistentItemException", () =>
                        Effect.succeed(undefined),
                      ),
                    ),
                );
                if (!found?.RegexPatternSet || found.LockToken === undefined) {
                  return;
                }
                yield* withWafScope(
                  scope,
                  wafv2
                    .deleteRegexPatternSet({
                      Name: output.regexPatternSetName,
                      Scope: scope,
                      Id: output.regexPatternSetId,
                      LockToken: found.LockToken,
                    })
                    .pipe(
                      Effect.catchTag(
                        "WAFNonexistentItemException",
                        () => Effect.void,
                      ),
                    ),
                );
              }),
            ),
          );
        }),
      };
    }),
  );
