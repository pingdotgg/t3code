import * as wafv2 from "@distilled.cloud/aws/wafv2";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  retryUnavailableEntity,
  retryUnavailableEntityLong,
} from "./internal.ts";

export interface WebACLAssociationProps {
  /**
   * ARN of the `REGIONAL` web ACL to associate.
   *
   * Changing the web ACL re-associates the resource in place
   * (`AssociateWebACL` overwrites any existing association).
   */
  webAclArn: string;
  /**
   * ARN of the regional resource to protect — an Application Load
   * Balancer, API Gateway REST API stage, AppSync GraphQL API, Cognito
   * user pool, App Runner service, Amplify application or Verified Access
   * instance. Changing the resource replaces the association.
   *
   * CloudFront distributions are NOT associated this way — set the
   * distribution's `webAclId` property to the web ACL's ARN instead.
   */
  resourceArn: string;
}

export interface WebACLAssociation extends Resource<
  "AWS.WAFv2.WebACLAssociation",
  WebACLAssociationProps,
  {
    /**
     * ARN of the associated web ACL.
     */
    webAclArn: string;
    /**
     * ARN of the protected resource.
     */
    resourceArn: string;
  },
  never,
  Providers
> {}

/**
 * Associates a `REGIONAL` AWS WAFv2 {@link WebACL} with a regional resource
 * (ALB, API Gateway stage, AppSync API, Cognito user pool, App Runner
 * service, Amplify app, Verified Access instance) to protect it.
 *
 * A resource can have at most one web ACL association; associating a
 * different web ACL overwrites the previous association in place.
 * CloudFront distributions are protected by setting
 * `Distribution.webAclId` instead — never through this resource.
 *
 * @resource
 * @section Associating Web ACLs
 * @example Protect a Cognito User Pool
 * ```typescript
 * const pool = yield* AWS.Cognito.UserPool("Users", {});
 *
 * const acl = yield* AWS.WAFv2.WebACL("PoolFirewall", {
 *   defaultAction: { Allow: {} },
 * });
 *
 * const association = yield* AWS.WAFv2.WebACLAssociation("PoolAssociation", {
 *   webAclArn: acl.webAclArn,
 *   resourceArn: pool.userPoolArn,
 * });
 * ```
 */
export const WebACLAssociation = Resource<WebACLAssociation>(
  "AWS.WAFv2.WebACLAssociation",
);

export const WebACLAssociationProvider = () =>
  Provider.effect(
    WebACLAssociation,
    Effect.gen(function* () {
      // Read the ARN of the web ACL currently protecting a resource
      // (undefined when the resource has no association or is gone). A
      // freshly created protected resource (e.g. a Cognito user pool) can
      // surface WAFUnavailableEntityException until WAF can "retrieve" it —
      // retry through propagation.
      const observeAssociation = Effect.fn(function* (resourceArn: string) {
        const response = yield* retryUnavailableEntity(
          wafv2.getWebACLForResource({ ResourceArn: resourceArn }),
        ).pipe(
          Effect.catchTag("WAFNonexistentItemException", () =>
            Effect.succeed({ WebACL: undefined }),
          ),
        );
        return response.WebACL?.ARN;
      });

      return {
        stables: ["webAclArn", "resourceArn"],

        // Associations have no enumeration API of their own (they are read
        // per-resource via getWebACLForResource), so nuke can't list them.
        // They dissolve with either endpoint anyway.
        list: () => Effect.succeed([]),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (olds.resourceArn !== news.resourceArn) {
            return { action: "replace" } as const;
          }
          // webAclArn changes apply in place — associateWebACL overwrites.
        }),

        read: Effect.fn(function* ({ olds, output }) {
          const resourceArn = output?.resourceArn ?? olds?.resourceArn;
          const webAclArn = output?.webAclArn ?? olds?.webAclArn;
          if (resourceArn === undefined) {
            return undefined;
          }
          const observed = yield* observeAssociation(resourceArn);
          if (observed === undefined || observed !== webAclArn) {
            // Nothing associated, or a foreign web ACL owns the slot.
            return undefined;
          }
          return { webAclArn: observed, resourceArn };
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          // 1. Observe — what protects the resource right now?
          const observed = yield* observeAssociation(news.resourceArn);

          // 2. Ensure — associate when missing or pointing elsewhere.
          //    associateWebACL is an upsert; a freshly created web ACL or
          //    protected resource (e.g. a new Cognito user pool) can be
          //    unavailable well past 90s, so retry on the long budget.
          if (observed !== news.webAclArn) {
            yield* retryUnavailableEntityLong(
              wafv2.associateWebACL({
                WebACLArn: news.webAclArn,
                ResourceArn: news.resourceArn,
              }),
            );
          }

          yield* session.note(
            `Associated ${news.webAclArn} with ${news.resourceArn}`,
          );
          return {
            webAclArn: news.webAclArn,
            resourceArn: news.resourceArn,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          // Idempotent: a missing resource or absent association is fine.
          // Retry transient unavailability so the web ACL can be deleted
          // right after (deleteWebACL fails while still associated).
          yield* retryUnavailableEntity(
            wafv2.disassociateWebACL({ ResourceArn: output.resourceArn }),
          ).pipe(
            Effect.catchTag(
              ["WAFNonexistentItemException", "WAFUnavailableEntityException"],
              () => Effect.void,
            ),
          );
        }),
      };
    }),
  );
