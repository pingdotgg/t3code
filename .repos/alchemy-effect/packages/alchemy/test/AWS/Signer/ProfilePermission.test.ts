import * as AWS from "@/AWS";
import { ProfilePermission, SigningProfile } from "@/AWS/Signer";
import * as Test from "@/Test/Alchemy";
import * as signer from "@distilled.cloud/aws/signer";
import * as sts from "@distilled.cloud/aws/sts";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

describe("AWS.Signer.ProfilePermission", () => {
  test.provider(
    "adds a cross-account permission, converges action changes in place, removes on destroy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const { Account } = yield* sts.getCallerIdentity({});
        const principal = Account!;

        // CREATE
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const profile = yield* SigningProfile("PermProfile", {
              platformId: "AWSLambda-SHA384-ECDSA",
            });
            const permission = yield* ProfilePermission("CiCanSign", {
              profileName: profile.profileName,
              action: "signer:StartSigningJob",
              principal,
            });
            return {
              profileName: permission.profileName,
              statementId: permission.statementId,
            };
          }),
        );

        // Verify out-of-band via distilled
        const observed = yield* signer.listProfilePermissions({
          profileName: created.profileName,
        });
        const statement = (observed.permissions ?? []).find(
          (p) => p.statementId === created.statementId,
        );
        expect(statement).toBeDefined();
        expect(statement!.action).toBe("signer:StartSigningJob");
        expect(statement!.principal).toBe(principal);

        // UPDATE — no update API: the provider removes + re-adds under the
        // SAME statement id (no replacement of the logical resource).
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            const profile = yield* SigningProfile("PermProfile", {
              platformId: "AWSLambda-SHA384-ECDSA",
            });
            const permission = yield* ProfilePermission("CiCanSign", {
              profileName: profile.profileName,
              action: "signer:GetSigningProfile",
              principal,
            });
            return {
              profileName: permission.profileName,
              statementId: permission.statementId,
            };
          }),
        );

        expect(updated.profileName).toEqual(created.profileName);
        expect(updated.statementId).toEqual(created.statementId);

        const afterUpdate = yield* signer.listProfilePermissions({
          profileName: created.profileName,
        });
        const updatedStatement = (afterUpdate.permissions ?? []).find(
          (p) => p.statementId === created.statementId,
        );
        expect(updatedStatement).toBeDefined();
        expect(updatedStatement!.action).toBe("signer:GetSigningProfile");

        // DESTROY — the statement is removed (the profile is canceled by its
        // own delete, but its policy must no longer contain our statement).
        yield* stack.destroy();
        const afterDestroy = yield* signer
          .listProfilePermissions({ profileName: created.profileName })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed({
                permissions: [] as signer.Permission[],
              } as signer.ListProfilePermissionsResponse),
            ),
          );
        expect(
          (afterDestroy.permissions ?? []).find(
            (p) => p.statementId === created.statementId,
          ),
        ).toBeUndefined();
      }),
    { timeout: 120_000 },
  );
});
