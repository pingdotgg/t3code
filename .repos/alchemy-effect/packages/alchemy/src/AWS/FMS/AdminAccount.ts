import * as fms from "@distilled.cloud/aws/fms";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { Region } from "../Region.ts";

// FMS admin-account management (get/associate/disassociate AdminAccount) is a
// global, organization-level operation served exclusively from the us-east-1
// endpoint — every other region rejects it with `InvalidOperationException:
// This operation is not supported in the '<region>' region.` Pin every
// control-plane call there regardless of the ambient stack region (same
// pattern as Cost Explorer / ECR Public / WAFv2 CloudFront-scope).
const FMS_ADMIN_REGION = "us-east-1";

/** Pin an FMS admin-account operation to the us-east-1 endpoint. */
export const pinFms = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(Region, Effect.succeed(FMS_ADMIN_REGION)));

export interface AdminAccountProps {
  /**
   * The AWS account ID to designate as the AWS Firewall Manager administrator
   * account for the organization. Must be an account in the same AWS
   * Organization as the caller (which must be the Organizations management
   * account). If omitted, the caller's account is used.
   */
  adminAccount?: string;
}

/** @resource */
export interface AdminAccount extends Resource<
  "AWS.FMS.AdminAccount",
  AdminAccountProps,
  {
    /** The account designated as the FMS administrator. */
    adminAccount: string;
    /** Status of the FMS administrator IAM role (`READY` / `CREATING` / ...). */
    roleStatus: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The AWS Firewall Manager administrator account — an organization-level
 * singleton that designates which account manages FMS security policies.
 *
 * :::caution
 * FMS requires the caller to be the AWS Organizations **management account**,
 * and the organization must have AWS Config enabled. On accounts that are not
 * an Organizations management account this resource fails at association time
 * with a typed `InvalidOperationException`.
 *
 * FMS admin-account APIs are served only from the us-east-1 endpoint; this
 * resource pins every control-plane call there regardless of the ambient
 * stack region.
 * :::
 *
 * This is a capture-and-restore singleton: FMS exposes no tags, so ownership is
 * tracked by Alchemy state — adopting a pre-existing admin account that Alchemy
 * did not create requires `--adopt`, and destroy disassociates the admin.
 *
 * @section Designating the FMS admin
 * @example Designate the caller as the FMS admin
 * ```typescript
 * const admin = yield* FMS.AdminAccount("FmsAdmin", {});
 * ```
 *
 * @example Designate a specific member account
 * ```typescript
 * const admin = yield* FMS.AdminAccount("FmsAdmin", {
 *   adminAccount: "123456789012",
 * });
 * ```
 */
const AdminAccountResource = Resource<AdminAccount>("AWS.FMS.AdminAccount");

export { AdminAccountResource as AdminAccount };

// `getAdminAccount` throws `ResourceNotFoundException` when no FMS admin has
// been designated — collapse to `undefined`.
const getAdmin = pinFms(fms.getAdminAccount({})).pipe(
  Effect.map((r) => r as fms.GetAdminAccountResponse | undefined),
  Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)),
);

export const AdminAccountProvider = () =>
  Provider.effect(
    AdminAccountResource,
    Effect.gen(function* () {
      // Association is asynchronous; the FMS role transitions CREATING → READY.
      const waitUntilReady = getAdmin.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (a) => a?.RoleStatus === "READY",
          times: 20,
        }),
      );

      return {
        read: Effect.fn(function* ({ output }) {
          const admin = yield* getAdmin;
          if (!admin?.AdminAccount) return undefined;
          const attrs = {
            adminAccount: admin.AdminAccount,
            roleStatus: admin.RoleStatus,
          };
          // FMS admin has no tags — ownership can't be verified from the cloud.
          // With no prior state, treat an existing admin as foreign.
          return output ? attrs : Unowned(attrs);
        }),

        // Organization-level singleton — report the single admin account.
        list: () =>
          getAdmin.pipe(
            Effect.map((a) =>
              a?.AdminAccount
                ? [{ adminAccount: a.AdminAccount, roleStatus: a.RoleStatus }]
                : [],
            ),
          ),

        reconcile: Effect.fn(function* ({ news = {}, session }) {
          const { accountId } = yield* AWSEnvironment.current;
          const desired = news.adminAccount ?? accountId;

          // 1. OBSERVE
          let admin = yield* getAdmin;

          // 2. ENSURE — associate the admin account if none is set.
          if (!admin?.AdminAccount) {
            // On a fresh account the first associate call kicks off creation
            // of the AWSServiceRoleForFMS service-linked role and fails
            // transiently while it materializes — either with a bare
            // `InvalidOperationException: Operation is invalid.` or with
            // `Service role name AWSServiceRoleForFMS already exists ...
            // Otherwise, try your request again.` Both are eventual-
            // consistency races, not terminal failures — retry bounded.
            yield* pinFms(
              fms.associateAdminAccount({ AdminAccount: desired }),
            ).pipe(
              Effect.retry({
                // `: boolean` blocks TS 5.5+ inferred type predicates — see
                // the note on the disassociate retry in `delete` below.
                while: (e): boolean =>
                  e._tag === "InvalidOperationException" &&
                  (e.Message === "Operation is invalid." ||
                    (e.Message?.includes("AWSServiceRoleForFMS") ?? false)),
                schedule: Schedule.spaced("5 seconds"),
                times: 8,
              }),
            );
            admin = yield* waitUntilReady;
          }

          // 3. RETURN fresh attributes.
          const final = yield* getAdmin;
          yield* session.note(desired);
          return {
            adminAccount: final?.AdminAccount ?? desired,
            roleStatus: final?.RoleStatus,
          };
        }),

        delete: Effect.fn(function* () {
          // For several minutes after association FMS reports the org as
          // "currently onboarding with AWS Firewall Manager and cannot be
          // offboarded" (a typed `InvalidOperationException`). Retry bounded;
          // onboarding can take >10 minutes, so a destroy issued immediately
          // after create may need to be re-run once onboarding settles.
          yield* pinFms(fms.disassociateAdminAccount({})).pipe(
            Effect.retry({
              // `: boolean` prevents TS 5.5+ from inferring a type predicate
              // for this lambda — an inferred `e is InvalidOperationException`
              // refinement makes `Effect.retry` collapse the error channel to
              // `unknown`, which breaks the `catchTag` below.
              while: (e): boolean =>
                e._tag === "InvalidOperationException" &&
                (e.Message?.includes("cannot be offboarded") ?? false),
              schedule: Schedule.spaced("8 seconds"),
              times: 8,
            }),
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      };
    }),
  );
