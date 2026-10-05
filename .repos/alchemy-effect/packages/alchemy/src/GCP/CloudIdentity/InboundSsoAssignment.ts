import * as cloudidentity from "@distilled.cloud/gcp/cloudidentity_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  expandGroup,
  findSsoAssignment,
  getSsoAssignment,
  lastSegment,
  listOwnedGroups,
  listSsoAssignments,
  normalizeCustomer,
  replaceOnIdentity,
  sameJson,
  sameText,
  updateMaskOf,
} from "./internal.ts";
import {
  resourceNameFromOperation,
  waitForOperation,
  waitUntilPresent,
} from "./operations.ts";

export type InboundSsoAssignmentSamlSsoInfo = {
  /** `inboundSamlSsoProfiles/{id}` to use when `ssoMode` is `SAML_SSO`. */
  inboundSamlSsoProfile?: string;
};

export type InboundSsoAssignmentOidcSsoInfo = {
  /** `inboundOidcSsoProfiles/{id}` to use when `ssoMode` is `OIDC_SSO`. */
  inboundOidcSsoProfile?: string;
};

export type InboundSsoAssignmentSignInBehavior = {
  /** When to redirect sign-ins to the IdP. */
  redirectCondition?:
    | cloudidentity.SignInBehaviorRedirectConditionEnum
    | (string & {});
};

export type InboundSsoAssignmentProps = {
  /**
   * Customer (`customers/C0123abc` or `customers/my_customer`).
   * Immutable — changing it replaces the assignment.
   * @default "customers/my_customer"
   */
  customer?: string;
  /**
   * Target group (`groups/{group}`). Immutable — changing it
   * replaces the assignment. Rank must be ≥ 1 when set.
   */
  targetGroup?: string;
  /**
   * Target org unit (`orgUnits/{org_unit}`). Immutable — changing
   * it replaces the assignment. Rank must be 0 (the default).
   */
  targetOrgUnit?: string;
  /**
   * Inbound SSO behavior.
   */
  ssoMode?: cloudidentity.InboundSsoAssignmentSsoModeEnum | (string & {});
  /**
   * Priority among group-targeted assignments. Zero for org units;
   * ≥ 1 for groups.
   */
  rank?: number;
  /**
   * SAML profile, required when `ssoMode` is `SAML_SSO`.
   */
  samlSsoInfo?: InboundSsoAssignmentSamlSsoInfo;
  /**
   * OIDC profile, required when `ssoMode` is `OIDC_SSO`.
   */
  oidcSsoInfo?: InboundSsoAssignmentOidcSsoInfo;
  /**
   * Sign-in redirect behavior.
   */
  signInBehavior?: InboundSsoAssignmentSignInBehavior;
};

export type InboundSsoAssignment = Resource<
  "GCP.CloudIdentity.InboundSsoAssignment",
  InboundSsoAssignmentProps,
  {
    /** Resource name `inboundSsoAssignments/{assignment}`. */
    name: string;
    /** Assignment id (last path segment). */
    assignmentId: string;
    /** Customer. */
    customer: string | undefined;
    /** Target group, if any. */
    targetGroup: string | undefined;
    /** Target org unit, if any. */
    targetOrgUnit: string | undefined;
    /** SSO mode. */
    ssoMode: string | undefined;
    /** Rank. */
    rank: number | undefined;
    /** SAML profile, if any. */
    samlSsoInfo: InboundSsoAssignmentSamlSsoInfo | undefined;
    /** OIDC profile, if any. */
    oidcSsoInfo: InboundSsoAssignmentOidcSsoInfo | undefined;
    /** Sign-in behavior. */
    signInBehavior: InboundSsoAssignmentSignInBehavior | undefined;
  },
  never,
  Providers
>;

/**
 * An inbound SSO assignment for a Cloud Identity group or org unit.
 *
 * Assignments have no labels or description, so Alchemy lists
 * assignments whose `targetGroup` is an alchemy-owned group for
 * `list` / nuke. Customer, target group, and target org unit are
 * identity; mode, rank, and IdP details update in place.
 *
 * ### Creating an Assignment
 * **Example:** SAML SSO for a group
 * ```typescript
 * const assignment = yield* GCP.CloudIdentity.InboundSsoAssignment(
 *   "EngSso",
 *   {
 *     targetGroup: group.name,
 *     ssoMode: "SAML_SSO",
 *     rank: 1,
 *     samlSsoInfo: { inboundSamlSsoProfile: profile.name },
 *   },
 * );
 * ```
 *
 * @resource
 * @category CloudIdentity
 */
export const InboundSsoAssignment = Resource<InboundSsoAssignment>(
  "GCP.CloudIdentity.InboundSsoAssignment",
);

export class InboundSsoAssignmentNotResolved extends Data.TaggedError(
  "GCP.CloudIdentity.InboundSsoAssignmentNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (assignment: cloudidentity.InboundSsoAssignment) => {
  const name = assignment.name ?? "";
  return {
    name,
    assignmentId: lastSegment(name),
    customer: assignment.customer,
    targetGroup: assignment.targetGroup,
    targetOrgUnit: assignment.targetOrgUnit,
    ssoMode: assignment.ssoMode,
    rank: assignment.rank,
    samlSsoInfo: assignment.samlSsoInfo
      ? { inboundSamlSsoProfile: assignment.samlSsoInfo.inboundSamlSsoProfile }
      : undefined,
    oidcSsoInfo: assignment.oidcSsoInfo
      ? { inboundOidcSsoProfile: assignment.oidcSsoInfo.inboundOidcSsoProfile }
      : undefined,
    signInBehavior: assignment.signInBehavior
      ? { redirectCondition: assignment.signInBehavior.redirectCondition }
      : undefined,
  };
};

const expandTargetGroup = (value: string | undefined) =>
  value !== undefined && value.length > 0 ? expandGroup(value) : undefined;

const observeAssignment = (input: {
  name?: string;
  targetGroup?: string;
  targetOrgUnit?: string;
  ssoMode?: string;
}) =>
  findSsoAssignment({
    name: input.name,
    targetGroup: expandTargetGroup(input.targetGroup),
    targetOrgUnit: input.targetOrgUnit,
    ssoMode: input.ssoMode,
  });

export const InboundSsoAssignmentProvider = () =>
  Provider.succeed(InboundSsoAssignment, {
    stables: [
      "name",
      "assignmentId",
      "customer",
      "targetGroup",
      "targetOrgUnit",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousCustomer = olds?.customer ?? output?.customer;
      const nextCustomer =
        news.customer !== undefined
          ? normalizeCustomer(news.customer)
          : previousCustomer;
      const previousGroup = olds?.targetGroup ?? output?.targetGroup;
      const nextGroup = expandTargetGroup(news.targetGroup);
      const previousOu = olds?.targetOrgUnit ?? output?.targetOrgUnit;
      return replaceOnIdentity({
        previousId: previousGroup,
        nextId: nextGroup,
        previousParent: previousCustomer,
        nextParent: nextCustomer,
        extra:
          news.targetOrgUnit !== undefined &&
          previousOu !== undefined &&
          news.targetOrgUnit !== previousOu,
      });
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const existing = yield* observeAssignment({
        name: output?.name,
        targetGroup: olds?.targetGroup ?? output?.targetGroup,
        targetOrgUnit: olds?.targetOrgUnit ?? output?.targetOrgUnit,
        ssoMode: olds?.ssoMode ?? output?.ssoMode,
      });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const groups = yield* listOwnedGroups();
        const names = new Set(
          groups
            .map((group) => group.name)
            .filter((name): name is string => name !== undefined),
        );
        const assignments = yield* listSsoAssignments();
        return assignments
          .filter(
            (assignment) =>
              assignment.targetGroup !== undefined &&
              names.has(assignment.targetGroup),
          )
          .map(toAttrs);
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const customer = normalizeCustomer(news.customer ?? output?.customer);
      const targetGroup = expandTargetGroup(news.targetGroup);
      const desired: cloudidentity.InboundSsoAssignment = {
        customer,
        targetGroup,
        targetOrgUnit: news.targetOrgUnit,
        ssoMode: news.ssoMode,
        rank: news.rank,
        samlSsoInfo: news.samlSsoInfo,
        oidcSsoInfo: news.oidcSsoInfo,
        signInBehavior: news.signInBehavior,
      };

      let current = yield* observeAssignment({
        name: output?.name,
        targetGroup,
        targetOrgUnit: news.targetOrgUnit ?? output?.targetOrgUnit,
        ssoMode: news.ssoMode ?? output?.ssoMode,
      });

      if (current === undefined) {
        const created = yield* cloudidentity
          .createInboundSsoAssignments({ body: desired })
          .pipe(
            Effect.catchTag("Conflict", () =>
              Effect.succeed<cloudidentity.Operation | undefined>(undefined),
            ),
          );
        if (created !== undefined) {
          yield* waitForOperation(created).pipe(
            Effect.catchTag(
              "GCP.CloudIdentity.OperationPending",
              () => Effect.void,
            ),
          );
          const createdName = resourceNameFromOperation(created);
          if (createdName !== undefined) {
            current = yield* getSsoAssignment(createdName);
          }
        }
        if (current === undefined) {
          current = yield* waitUntilPresent(
            observeAssignment({
              name: output?.name,
              targetGroup,
              targetOrgUnit: news.targetOrgUnit,
              ssoMode: news.ssoMode,
            }),
            targetGroup ?? news.targetOrgUnit ?? "",
          ).pipe(
            Effect.catchTag("GCP.CloudIdentity.OperationPending", () =>
              observeAssignment({
                targetGroup,
                targetOrgUnit: news.targetOrgUnit,
                ssoMode: news.ssoMode,
              }),
            ),
          );
        }
      }

      if (current === undefined) {
        return yield* new InboundSsoAssignmentNotResolved({
          name: output?.name ?? targetGroup ?? news.targetOrgUnit ?? "",
        });
      }

      const name = current.name ?? output?.name ?? "";
      const modeChanged =
        news.ssoMode !== undefined && !sameText(current.ssoMode, news.ssoMode);
      const rankChanged =
        news.rank !== undefined && (current.rank ?? 0) !== news.rank;
      const samlChanged =
        news.samlSsoInfo !== undefined &&
        !sameJson(current.samlSsoInfo, news.samlSsoInfo);
      const oidcChanged =
        news.oidcSsoInfo !== undefined &&
        !sameJson(current.oidcSsoInfo, news.oidcSsoInfo);
      const signInChanged =
        news.signInBehavior !== undefined &&
        !sameJson(current.signInBehavior, news.signInBehavior);
      const updateMask = updateMaskOf(
        modeChanged ? "sso_mode" : undefined,
        rankChanged ? "rank" : undefined,
        samlChanged ? "saml_sso_info" : undefined,
        oidcChanged ? "oidc_sso_info" : undefined,
        signInChanged ? "sign_in_behavior" : undefined,
      );

      if (updateMask.length > 0 && name.length > 0) {
        const patched = yield* cloudidentity.patchInboundSsoAssignments({
          name,
          updateMask,
          body: {
            ssoMode: news.ssoMode,
            rank: news.rank,
            samlSsoInfo: news.samlSsoInfo,
            oidcSsoInfo: news.oidcSsoInfo,
            signInBehavior: news.signInBehavior,
          },
        });
        yield* waitForOperation(patched).pipe(
          Effect.catchTag(
            "GCP.CloudIdentity.OperationPending",
            () => Effect.void,
          ),
        );
        current = (yield* getSsoAssignment(name)) ?? current;
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.name.length === 0) return;
      const deleted = yield* cloudidentity
        .deleteInboundSsoAssignments({ name: output.name })
        .pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed<cloudidentity.Operation | undefined>(undefined),
          ),
        );
      if (deleted !== undefined) {
        yield* waitForOperation(deleted, { notFoundOk: true });
      }
    }),
  });
