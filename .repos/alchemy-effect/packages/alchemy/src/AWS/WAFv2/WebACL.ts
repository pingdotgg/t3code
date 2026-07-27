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
  normalizeWafRules,
  retryAssociatedItem,
  retryOptimisticLock,
  retryUnavailableEntity,
  syncWafTags,
  type WafScope,
  withWafScope,
} from "./internal.ts";

export interface WebACLProps {
  /**
   * Name of the web ACL. Must match `^[\w\-]+$` and be 1-128 characters.
   * Changing the name replaces the web ACL.
   * @default a physical name derived from the app, stage and logical ID
   */
  webAclName?: string;
  /**
   * Scope of the web ACL. `REGIONAL` protects regional resources (ALB,
   * API Gateway, AppSync, Cognito user pool, App Runner, Verified Access)
   * in the ambient region; `CLOUDFRONT` protects CloudFront distributions
   * and is always provisioned in `us-east-1` (the provider pins the region
   * automatically). Changing the scope replaces the web ACL.
   * @default "REGIONAL"
   */
  scope?: WafScope;
  /**
   * Action to take on a request that matches none of the rules.
   * @default { Allow: {} }
   */
  defaultAction?: WAFV2.DefaultAction;
  /**
   * Description of the web ACL.
   */
  description?: string;
  /**
   * Rules to evaluate, in `Priority` order. Supports custom statements
   * (byte match, rate-based, geo, IP set references, ...) and managed rule
   * groups (e.g. `AWSManagedRulesCommonRuleSet`). Raw WAFv2 API shapes.
   */
  rules?: WAFV2.Rule[];
  /**
   * CloudWatch metrics and sampled-request settings for the web ACL itself.
   * @default sampled requests + metrics enabled, MetricName = the web ACL name
   */
  visibilityConfig?: WAFV2.VisibilityConfig;
  /**
   * Custom response bodies referenced by rule actions in this web ACL.
   */
  customResponseBodies?: {
    [key: string]: WAFV2.CustomResponseBody | undefined;
  };
  /**
   * Default CAPTCHA immunity-time configuration.
   */
  captchaConfig?: WAFV2.CaptchaConfig;
  /**
   * Default challenge immunity-time configuration.
   */
  challengeConfig?: WAFV2.ChallengeConfig;
  /**
   * Domains that WAF accepts for CAPTCHA/challenge tokens.
   */
  tokenDomains?: string[];
  /**
   * Association-level configuration (e.g. request body size limits).
   */
  associationConfig?: WAFV2.AssociationConfig;
  /**
   * User-defined tags to apply to the web ACL.
   */
  tags?: Record<string, string>;
}

export interface WebACL extends Resource<
  "AWS.WAFv2.WebACL",
  WebACLProps,
  {
    /**
     * Name of the web ACL.
     */
    webAclName: string;
    /**
     * WAF-assigned unique ID of the web ACL.
     */
    webAclId: string;
    /**
     * ARN of the web ACL. Use this to associate regional resources
     * (via {@link WebACLAssociation}) or as CloudFront's `webAclId`.
     */
    webAclArn: string;
    /**
     * Scope the web ACL was created in.
     */
    scope: WafScope;
  },
  never,
  Providers
> {}

/**
 * An AWS WAFv2 Web ACL — a collection of rules that inspect and control web
 * requests for the AWS resources it is associated with.
 *
 * `REGIONAL` web ACLs protect regional resources (Application Load Balancer,
 * API Gateway, AppSync, Cognito user pools, App Runner, Verified Access) via
 * {@link WebACLAssociation}. `CLOUDFRONT` web ACLs protect CloudFront
 * distributions (set `Distribution.webAclId` to the web ACL's ARN) and are
 * always provisioned in `us-east-1` — the provider pins the region for you.
 *
 * @resource
 * @section Creating Web ACLs
 * @example Allow-by-Default Web ACL with a Managed Rule Group
 * ```typescript
 * const acl = yield* AWS.WAFv2.WebACL("ApiFirewall", {
 *   rules: [
 *     {
 *       Name: "common-rule-set",
 *       Priority: 0,
 *       Statement: {
 *         ManagedRuleGroupStatement: {
 *           VendorName: "AWS",
 *           Name: "AWSManagedRulesCommonRuleSet",
 *         },
 *       },
 *       OverrideAction: { None: {} },
 *       VisibilityConfig: {
 *         SampledRequestsEnabled: true,
 *         CloudWatchMetricsEnabled: true,
 *         MetricName: "common-rule-set",
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @example Rate Limiting Requests per IP
 * ```typescript
 * const acl = yield* AWS.WAFv2.WebACL("RateLimited", {
 *   defaultAction: { Allow: {} },
 *   rules: [
 *     {
 *       Name: "rate-limit",
 *       Priority: 0,
 *       Statement: {
 *         RateBasedStatement: { Limit: 100, AggregateKeyType: "IP" },
 *       },
 *       Action: { Block: {} },
 *       VisibilityConfig: {
 *         SampledRequestsEnabled: true,
 *         CloudWatchMetricsEnabled: true,
 *         MetricName: "rate-limit",
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @section CloudFront Scope
 * @example Web ACL for a CloudFront Distribution
 * ```typescript
 * const acl = yield* AWS.WAFv2.WebACL("EdgeFirewall", {
 *   scope: "CLOUDFRONT", // provisioned in us-east-1 automatically
 *   defaultAction: { Allow: {} },
 * });
 *
 * const distribution = yield* AWS.CloudFront.Distribution("Site", {
 *   // ...
 *   webAclId: acl.webAclArn,
 * });
 * ```
 *
 * @section Protecting Regional Resources
 * @example Associate with a Cognito User Pool
 * ```typescript
 * const association = yield* AWS.WAFv2.WebACLAssociation("PoolFirewall", {
 *   webAclArn: acl.webAclArn,
 *   resourceArn: userPool.userPoolArn,
 * });
 * ```
 */
export const WebACL = Resource<WebACL>("AWS.WAFv2.WebACL");

const defaultScope: WafScope = "REGIONAL";

const defaultVisibilityConfig = (name: string): WAFV2.VisibilityConfig => ({
  SampledRequestsEnabled: true,
  CloudWatchMetricsEnabled: true,
  MetricName: name,
});

const toAttrs = (acl: WAFV2.WebACL, scope: WafScope) => ({
  webAclName: acl.Name,
  webAclId: acl.Id,
  webAclArn: acl.ARN,
  scope,
});

export const WebACLProvider = () =>
  Provider.effect(
    WebACL,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (id: string, props: WebACLProps) {
        return (
          props.webAclName ??
          (yield* createPhysicalName({ id, maxLength: 128 }))
        );
      });

      // Resolve a web ACL to its full detail + LockToken. Prefers the
      // cached Id (fast path); falls back to searching list pages by name.
      const findWebACL = Effect.fn(function* (
        scope: WafScope,
        name: string,
        cachedId: string | undefined,
      ) {
        if (cachedId !== undefined) {
          const byId = yield* withWafScope(
            scope,
            wafv2
              .getWebACL({ Name: name, Scope: scope, Id: cachedId })
              .pipe(
                Effect.catchTag("WAFNonexistentItemException", () =>
                  Effect.succeed(undefined),
                ),
              ),
          );
          if (byId?.WebACL) {
            return byId;
          }
        }
        let marker: string | undefined;
        for (let page = 0; page < 20; page++) {
          const listed = yield* withWafScope(
            scope,
            wafv2.listWebACLs({ Scope: scope, NextMarker: marker, Limit: 100 }),
          );
          const summary = listed.WebACLs?.find((s) => s.Name === name);
          if (summary?.Id !== undefined) {
            return yield* withWafScope(
              scope,
              wafv2
                .getWebACL({ Name: name, Scope: scope, Id: summary.Id })
                .pipe(
                  Effect.catchTag("WAFNonexistentItemException", () =>
                    Effect.succeed(undefined),
                  ),
                ),
            );
          }
          if (!listed.NextMarker || (listed.WebACLs?.length ?? 0) === 0) {
            break;
          }
          marker = listed.NextMarker;
        }
        return undefined;
      });

      const buildDesired = (name: string, props: WebACLProps) => ({
        DefaultAction: props.defaultAction ?? { Allow: {} },
        Description: props.description,
        // props survive engine serialization as plain JSON — restore
        // ByteMatchStatement SearchString blobs to Uint8Array
        Rules: normalizeWafRules(props.rules),
        VisibilityConfig:
          props.visibilityConfig ?? defaultVisibilityConfig(name),
        CustomResponseBodies: props.customResponseBodies,
        CaptchaConfig: props.captchaConfig,
        ChallengeConfig: props.challengeConfig,
        TokenDomains: props.tokenDomains,
        AssociationConfig: props.associationConfig,
      });

      const listScope = Effect.fn(function* (scope: WafScope) {
        const rows: ReturnType<typeof toAttrs>[] = [];
        let marker: string | undefined;
        for (let page = 0; page < 50; page++) {
          const listed = yield* withWafScope(
            scope,
            wafv2.listWebACLs({ Scope: scope, NextMarker: marker, Limit: 100 }),
          );
          for (const summary of listed.WebACLs ?? []) {
            if (summary.Name && summary.Id && summary.ARN) {
              rows.push({
                webAclName: summary.Name,
                webAclId: summary.Id,
                webAclArn: summary.ARN,
                scope,
              });
            }
          }
          if (!listed.NextMarker || (listed.WebACLs?.length ?? 0) === 0) {
            break;
          }
          marker = listed.NextMarker;
        }
        return rows;
      });

      return {
        stables: ["webAclName", "webAclId", "webAclArn", "scope"],

        list: () =>
          Effect.gen(function* () {
            const regional = yield* listScope("REGIONAL");
            const cloudfront = yield* listScope("CLOUDFRONT");
            return [...regional, ...cloudfront];
          }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          if ((olds?.scope ?? defaultScope) !== (news.scope ?? defaultScope)) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const scope = output?.scope ?? olds?.scope ?? defaultScope;
          const name =
            output?.webAclName ?? (yield* createName(id, olds ?? {}));
          const found = yield* findWebACL(scope, name, output?.webAclId);
          if (!found?.WebACL) {
            return undefined;
          }
          const attrs = toAttrs(found.WebACL, scope);
          const tags = yield* fetchWafTags(scope, found.WebACL.ARN);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const scope = news.scope ?? defaultScope;
          const name = output?.webAclName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const desired = buildDesired(name, news);

          // 1. Observe — cloud state is authoritative; output only caches Id.
          let observed = yield* findWebACL(scope, name, output?.webAclId);

          // 2. Ensure — create if missing; a WAFDuplicateItemException is a
          //    race with a concurrent creator, so fall through to re-read.
          if (!observed?.WebACL) {
            yield* retryUnavailableEntity(
              withWafScope(
                scope,
                wafv2
                  .createWebACL({
                    Name: name,
                    Scope: scope,
                    ...desired,
                    Tags: createTagsList(desiredTags),
                  })
                  .pipe(
                    Effect.catchTag("WAFDuplicateItemException", () =>
                      Effect.succeed(undefined),
                    ),
                  ),
              ),
            );
            observed = yield* findWebACL(scope, name, undefined);
          }

          if (!observed?.WebACL) {
            return yield* Effect.fail(
              new Error(`Failed to observe WebACL '${name}' after create`),
            );
          }

          const acl = observed.WebACL;
          yield* session.note(acl.ARN);

          // 3. Sync — diff the OBSERVED mutable aspects against desired and
          //    apply a single updateWebACL when drifted. The update re-reads
          //    the LockToken inside the retry so optimistic-lock conflicts
          //    converge.
          const observedAspects: Record<string, unknown> = {
            DefaultAction: acl.DefaultAction,
            Description: acl.Description,
            Rules: acl.Rules ?? [],
            VisibilityConfig: acl.VisibilityConfig,
            TokenDomains: acl.TokenDomains,
          };
          const desiredAspects: Record<string, unknown> = {
            DefaultAction: desired.DefaultAction,
            Description: desired.Description,
            Rules: desired.Rules,
            VisibilityConfig: desired.VisibilityConfig,
            TokenDomains: desired.TokenDomains,
          };
          // WAF materializes defaults for aspects the user never set (e.g.
          // CaptchaConfig immunity time), so only compare the optional
          // aspects the user actually declared.
          if (news.customResponseBodies !== undefined) {
            observedAspects.CustomResponseBodies = acl.CustomResponseBodies;
            desiredAspects.CustomResponseBodies = desired.CustomResponseBodies;
          }
          if (news.captchaConfig !== undefined) {
            observedAspects.CaptchaConfig = acl.CaptchaConfig;
            desiredAspects.CaptchaConfig = desired.CaptchaConfig;
          }
          if (news.challengeConfig !== undefined) {
            observedAspects.ChallengeConfig = acl.ChallengeConfig;
            desiredAspects.ChallengeConfig = desired.ChallengeConfig;
          }
          if (news.associationConfig !== undefined) {
            observedAspects.AssociationConfig = acl.AssociationConfig;
            desiredAspects.AssociationConfig = desired.AssociationConfig;
          }
          if (
            !deepEqual(observedAspects, desiredAspects, { stripNullish: true })
          ) {
            yield* retryOptimisticLock(
              Effect.gen(function* () {
                const fresh = yield* findWebACL(scope, name, acl.Id);
                if (!fresh?.WebACL || fresh.LockToken === undefined) {
                  return;
                }
                yield* retryUnavailableEntity(
                  withWafScope(
                    scope,
                    wafv2.updateWebACL({
                      Name: name,
                      Scope: scope,
                      Id: fresh.WebACL.Id,
                      LockToken: fresh.LockToken,
                      ...desired,
                    }),
                  ),
                );
              }),
            );
          }

          // 3b. Sync tags against OBSERVED cloud tags.
          yield* syncWafTags(scope, acl.ARN, desiredTags);

          // 4. Return fresh attributes.
          return toAttrs(acl, scope);
        }),

        delete: Effect.fn(function* ({ output }) {
          const scope = output.scope;
          // Re-read for a fresh LockToken on every attempt; tolerate the
          // ACL already being gone, a stale lock, or a still-propagating
          // disassociation.
          yield* retryAssociatedItem(
            retryOptimisticLock(
              Effect.gen(function* () {
                const found = yield* withWafScope(
                  scope,
                  wafv2
                    .getWebACL({
                      Name: output.webAclName,
                      Scope: scope,
                      Id: output.webAclId,
                    })
                    .pipe(
                      Effect.catchTag("WAFNonexistentItemException", () =>
                        Effect.succeed(undefined),
                      ),
                    ),
                );
                if (!found?.WebACL || found.LockToken === undefined) {
                  return;
                }
                yield* withWafScope(
                  scope,
                  wafv2
                    .deleteWebACL({
                      Name: output.webAclName,
                      Scope: scope,
                      Id: output.webAclId,
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
