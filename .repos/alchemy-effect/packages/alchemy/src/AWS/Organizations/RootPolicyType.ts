import * as organizations from "@distilled.cloud/aws/organizations";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { collectPages, retryOrganizations } from "./common.ts";

export interface RootPolicyTypeProps {
  /**
   * Root that owns the enabled policy type.
   */
  rootId: string;
  /**
   * Policy type to enable on the root.
   */
  policyType: organizations.PolicyType;
}

export interface RootPolicyType extends Resource<
  "AWS.Organizations.RootPolicyType",
  RootPolicyTypeProps,
  {
    /**
     * ID of the root the policy type is enabled on.
     */
    rootId: string;
    /**
     * ARN of the root.
     */
    rootArn: string | undefined;
    /**
     * The enabled policy type.
     */
    policyType: organizations.PolicyType;
    /**
     * Enablement status (`ENABLED`, `PENDING_ENABLE`, or `PENDING_DISABLE`).
     */
    status: organizations.PolicyTypeStatus | undefined;
  },
  never,
  Providers
> {}

/**
 * Enables a policy type on an organization root.
 *
 * A policy type (SCP, tag policy, ...) must be enabled on the root before any
 * {@link Policy} of that type can be attached via {@link PolicyAttachment}.
 * Existence-only resource: changing `rootId` or `policyType` replaces it.
 * @resource
 * @section Enabling Policy Types
 * @example Enable Service Control Policies
 * ```typescript
 * const root = yield* Root("Root", {});
 *
 * const scpEnabled = yield* RootPolicyType("ScpEnabled", {
 *   rootId: root.rootId,
 *   policyType: "SERVICE_CONTROL_POLICY",
 * });
 * ```
 *
 * @example Enable Tag Policies Before Attaching One
 * ```typescript
 * const tagPoliciesEnabled = yield* RootPolicyType("TagPoliciesEnabled", {
 *   rootId: root.rootId,
 *   policyType: "TAG_POLICY",
 * });
 *
 * yield* PolicyAttachment("RequireEnvTagOnRoot", {
 *   policyId: tagPolicy.policyId,
 *   // depend on the enablement so attachment happens after it
 *   targetId: tagPoliciesEnabled.rootId,
 * });
 * ```
 */
export const RootPolicyType = Resource<RootPolicyType>(
  "AWS.Organizations.RootPolicyType",
);

export const RootPolicyTypeProvider = () =>
  Provider.effect(
    RootPolicyType,
    Effect.gen(function* () {
      return {
        stables: ["rootId", "rootArn", "policyType"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (
            olds?.rootId !== news.rootId ||
            olds?.policyType !== news.policyType
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const rootId = output?.rootId ?? olds?.rootId;
          const policyType = output?.policyType ?? olds?.policyType;
          if (rootId === undefined || policyType === undefined) {
            // Output-valued props don't survive a `creating`-state round-trip
            // (they deserialize as `undefined`) — report "not found" so the
            // engine re-drives the create.
            return undefined;
          }
          return yield* readRootPolicyType({ rootId, policyType });
        }),
        // A RootPolicyType is the enable/disable state of one policy type on
        // one organization root. `listRoots` already returns each root's
        // `PolicyTypes` array inline, so we enumerate roots and emit one
        // `Attributes` per (rootId, policyType) — no per-root fan-out needed.
        // Outside an org management account `listRoots` rejects with a typed
        // error, which we degrade to [].
        list: () =>
          collectPages(
            (NextToken) => organizations.listRoots({ NextToken }),
            (page) => page.Roots,
          ).pipe(
            retryOrganizations,
            Effect.map((roots) =>
              roots.flatMap((root) =>
                root.Id == null
                  ? []
                  : (root.PolicyTypes ?? [])
                      .filter(
                        (
                          summary,
                        ): summary is organizations.PolicyTypeSummary & {
                          Type: organizations.PolicyType;
                        } => summary.Type != null,
                      )
                      .map(
                        (summary) =>
                          ({
                            rootId: root.Id!,
                            rootArn: root.Arn,
                            policyType: summary.Type,
                            status: summary.Status,
                          }) satisfies RootPolicyType["Attributes"],
                      ),
              ),
            ),
            Effect.catchTags({
              AWSOrganizationsNotInUseException: () =>
                Effect.succeed<RootPolicyType["Attributes"][]>([]),
              AccessDeniedException: () =>
                Effect.succeed<RootPolicyType["Attributes"][]>([]),
            }),
          ),
        reconcile: Effect.fn(function* ({ news, session }) {
          // Observe — read the root's policy-type list to see whether our
          // type is already enabled. Both `rootId` and `policyType` are
          // stable identifiers, so `diff` replaces on any change.
          let state = yield* readRootPolicyType(news);

          // Ensure — enable if missing. Tolerate
          // `PolicyTypeAlreadyEnabledException` for idempotency. The list
          // can lag behind the enable call, so we fall back to a
          // `PENDING_ENABLE` synthetic state when read still returns nothing.
          if (!state) {
            yield* retryOrganizations(
              organizations
                .enablePolicyType({
                  RootId: news.rootId,
                  PolicyType: news.policyType,
                })
                .pipe(
                  Effect.catchTag(
                    "PolicyTypeAlreadyEnabledException",
                    () => Effect.void,
                  ),
                ),
            );

            state = yield* readRootPolicyType(news);
            if (!state) {
              return {
                rootId: news.rootId,
                rootArn: undefined,
                policyType: news.policyType,
                status: "PENDING_ENABLE",
              } satisfies RootPolicyType["Attributes"];
            }
          }

          yield* session.note(state.rootArn ?? state.rootId);
          return state;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryOrganizations(
            organizations
              .disablePolicyType({
                RootId: output.rootId,
                PolicyType: output.policyType,
              })
              .pipe(
                Effect.catchTags({
                  PolicyTypeNotEnabledException: () => Effect.void,
                  RootNotFoundException: () => Effect.void,
                }),
              ),
          );
        }),
      };
    }),
  );

const readRoot = (rootId: string) =>
  collectPages(
    (NextToken) => organizations.listRoots({ NextToken }),
    (page) => page.Roots,
  ).pipe(
    retryOrganizations,
    Effect.map((roots) => roots.find((root) => root.Id === rootId)),
  );

const readRootPolicyType = Effect.fn(function* ({
  rootId,
  policyType,
}: RootPolicyTypeProps) {
  const root = yield* readRoot(rootId);
  const summary = root?.PolicyTypes?.find((item) => item.Type === policyType);
  return summary
    ? ({
        rootId,
        rootArn: root?.Arn,
        policyType,
        status: summary.Status,
      } satisfies RootPolicyType["Attributes"])
    : undefined;
});
