import * as signer from "@distilled.cloud/aws/signer";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface ProfilePermissionProps {
  /**
   * The name of the signing profile the permission is attached to.
   * Changing it replaces the permission.
   */
  profileName: string;

  /**
   * The Signer action the principal is allowed to perform on the profile:
   * `signer:StartSigningJob`, `signer:SignPayload`,
   * `signer:GetSigningProfile`, or `signer:RevokeSignature`.
   */
  action: string;

  /**
   * The AWS principal (account id, or IAM user/role ARN) receiving
   * cross-account permission to use the profile.
   */
  principal: string;

  /**
   * A unique statement id identifying this permission inside the profile's
   * resource policy. If omitted, a deterministic id is generated from the
   * logical id. Changing it replaces the permission.
   */
  statementId?: string;

  /**
   * The signing profile version the permission applies to. Omit to attach
   * the permission to the profile as a whole.
   */
  profileVersion?: string;
}

export interface ProfilePermission extends Resource<
  "AWS.Signer.ProfilePermission",
  ProfilePermissionProps,
  {
    /** The name of the signing profile the permission is attached to. */
    profileName: string;
    /** The statement id of the permission inside the profile's policy. */
    statementId: string;
  },
  never,
  Providers
> {}

/**
 * A cross-account permission on an AWS Signer signing profile — one statement
 * in the profile's resource policy granting another AWS account (or IAM
 * identity) a Signer action such as `signer:StartSigningJob`. The Signer
 * counterpart of CloudFormation's `AWS::Signer::ProfilePermission`.
 *
 * Permissions have no update API: changing the `action`, `principal`, or
 * `profileVersion` converges by removing and re-adding the statement under
 * the same statement id (revision-checked, so concurrent policy edits are
 * retried); changing `profileName` or `statementId` replaces the permission.
 *
 * @resource
 * @section Sharing a Signing Profile
 * @example Allow Another Account to Sign
 * ```typescript
 * const profile = yield* Signer.SigningProfile("ReleaseProfile", {
 *   platformId: "AWSLambda-SHA384-ECDSA",
 * });
 *
 * const permission = yield* Signer.ProfilePermission("CiAccountCanSign", {
 *   profileName: profile.profileName,
 *   action: "signer:StartSigningJob",
 *   principal: "123456789012",
 * });
 * ```
 *
 * @example Pin the Permission to a Profile Version
 * ```typescript
 * const permission = yield* Signer.ProfilePermission("CiAccountCanSign", {
 *   profileName: profile.profileName,
 *   action: "signer:StartSigningJob",
 *   principal: "123456789012",
 *   profileVersion: profile.profileVersion,
 * });
 * ```
 */
export const ProfilePermission = Resource<ProfilePermission>(
  "AWS.Signer.ProfilePermission",
);

/**
 * The profile policy is capped at 20 statements, but the list API still
 * pages — walk it fully so revision ids and statement lookups are accurate.
 * A profile that has never had a permission answers with a typed
 * `ResourceNotFoundException` ("No policies associated with profile …") —
 * observed as an empty policy. A genuinely missing profile surfaces on the
 * subsequent `addProfilePermission` instead.
 */
const listAllPermissions = Effect.fn(function* (profileName: string) {
  const permissions: signer.Permission[] = [];
  let revisionId: string | undefined;
  let nextToken: string | undefined;
  do {
    const page = yield* signer
      .listProfilePermissions({ profileName, nextToken })
      .pipe(
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed({
            permissions: [] as signer.Permission[],
            revisionId: undefined,
            nextToken: undefined,
          } as signer.ListProfilePermissionsResponse),
        ),
      );
    permissions.push(...(page.permissions ?? []));
    revisionId = page.revisionId ?? revisionId;
    nextToken = page.nextToken;
  } while (nextToken !== undefined);
  return { permissions, revisionId };
});

/** Concurrent policy edits bump the revision id — re-observe and retry. */
const conflictRetry = {
  while: (e: { _tag: string }): boolean => e._tag === "ConflictException",
  schedule: Schedule.exponential("500 millis"),
  times: 5,
} as const;

export const ProfilePermissionProvider = () =>
  Provider.effect(
    ProfilePermission,
    Effect.gen(function* () {
      const createStatementId = Effect.fn(function* (
        id: string,
        props: Pick<ProfilePermissionProps, "statementId">,
      ) {
        return (
          props.statementId ??
          // Signer rejects statement ids of 64+ characters.
          (yield* createPhysicalName({ id, delimiter: "-", maxLength: 63 }))
        );
      });

      return ProfilePermission.Provider.of({
        stables: ["profileName", "statementId"],

        list: () =>
          Effect.gen(function* () {
            // A ProfilePermission is one statement inside a profile's
            // resource policy — fan out: enumerate active profiles, list
            // each policy, emit one Attributes per statement id.
            const profileNames = yield* signer.listSigningProfiles
              .pages({ includeCanceled: false })
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk).flatMap((page) =>
                    (page.profiles ?? [])
                      .map((p) => p.profileName)
                      .filter((name): name is string => name != null),
                  ),
                ),
              );
            const perProfile = yield* Effect.forEach(
              profileNames,
              (profileName) =>
                listAllPermissions(profileName).pipe(
                  Effect.map(({ permissions }) =>
                    permissions
                      .filter(
                        (p): p is signer.Permission & { statementId: string } =>
                          typeof p.statementId === "string",
                      )
                      .map((p) => ({
                        profileName,
                        statementId: p.statementId,
                      })),
                  ),
                ),
              { concurrency: 5 },
            );
            return perProfile.flat();
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const profileName = output?.profileName ?? olds?.profileName;
          if (profileName === undefined) return undefined;
          const statementId =
            output?.statementId ?? (yield* createStatementId(id, olds ?? {}));
          const { permissions } = yield* listAllPermissions(profileName);
          const statement = permissions.find(
            (p) => p.statementId === statementId,
          );
          if (statement === undefined) return undefined;
          return { profileName, statementId };
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldStatementId = yield* createStatementId(id, olds);
          const newStatementId = yield* createStatementId(id, news);
          // The statement id is the permission's identity within the policy
          // and the profile is the policy's host — either change replaces.
          // action/principal/profileVersion converge in reconcile via
          // remove + re-add under the same statement id.
          if (
            news.profileName !== olds.profileName ||
            oldStatementId !== newStatementId
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const statementId =
            output?.statementId ?? (yield* createStatementId(id, news));

          yield* Effect.gen(function* () {
            // OBSERVE — the profile's policy is authoritative.
            const { permissions, revisionId } = yield* listAllPermissions(
              news.profileName,
            );
            const existing = permissions.find(
              (p) => p.statementId === statementId,
            );

            // SYNC — statements have no update API. If the existing statement
            // differs from the desired one, remove it (revision-checked) and
            // fall through to re-add.
            if (existing !== undefined) {
              const matches =
                existing.action === news.action &&
                existing.principal === news.principal &&
                (existing.profileVersion ?? undefined) ===
                  (news.profileVersion ?? undefined);
              if (matches) return;
              yield* signer
                .removeProfilePermission({
                  profileName: news.profileName,
                  statementId,
                  revisionId: revisionId!,
                })
                .pipe(
                  // Already removed by a concurrent writer — proceed to add.
                  Effect.catchTag(
                    "ResourceNotFoundException",
                    () => Effect.void,
                  ),
                );
            }

            // ENSURE — add the desired statement. A ConflictException here is
            // a revision race (or the remove above still propagating); the
            // outer retry re-observes and converges.
            yield* signer.addProfilePermission({
              profileName: news.profileName,
              action: news.action,
              principal: news.principal,
              statementId,
              profileVersion: news.profileVersion,
              revisionId: existing !== undefined ? undefined : revisionId,
            });
          }).pipe(Effect.retry(conflictRetry));

          yield* session.note(`${statementId} on ${news.profileName}`);
          return { profileName: news.profileName, statementId };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* Effect.gen(function* () {
            const { permissions, revisionId } = yield* listAllPermissions(
              output.profileName,
            );
            const existing = permissions.find(
              (p) => p.statementId === output.statementId,
            );
            if (existing === undefined || revisionId === undefined) return;
            yield* signer
              .removeProfilePermission({
                profileName: output.profileName,
                statementId: output.statementId,
                revisionId,
              })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              );
          }).pipe(Effect.retry(conflictRetry));
        }),
      });
    }),
  );
