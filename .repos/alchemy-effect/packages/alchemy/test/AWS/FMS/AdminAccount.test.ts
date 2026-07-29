import * as AWS from "@/AWS";
import { AdminAccount, pinFms } from "@/AWS/FMS/AdminAccount.ts";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import * as Test from "@/Test/Alchemy";
import * as fms from "@distilled.cloud/aws/fms";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// FMS admin-account APIs are only served from us-east-1 — all direct distilled
// calls below are pinned there via `pinFms` (same as the provider).
const getAdmin = pinFms(fms.getAdminAccount({})).pipe(
  Effect.map((r) => r as fms.GetAdminAccountResponse | undefined),
  Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)),
);

// Ungated typed-error probe: on an organization with no FMS admin designated,
// `getAdminAccount` must surface as a typed `ResourceNotFoundException` from
// distilled's `GetAdminAccountError` union. This proves the SDK's typed error
// mapping at near-zero cost and never mutates the organization.
test.provider(
  "getAdminAccount with no admin designated returns a typed ResourceNotFoundException",
  (_stack) =>
    Effect.gen(function* () {
      const existing = yield* getAdmin;
      if (existing?.AdminAccount) {
        yield* Effect.logInfo(
          `FMS admin already configured (${existing.AdminAccount}) — probe skipped`,
        );
        return;
      }

      const result = yield* Effect.result(pinFms(fms.getAdminAccount({})));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("ResourceNotFoundException");
      }
    }),
  { timeout: 60_000 },
);

// Full live lifecycle. FMS requires the caller to be the AWS Organizations
// management account (the testing account is), with the admin APIs pinned to
// us-east-1 by the provider. The lifecycle is gated because FMS organization
// onboarding is genuinely slow: for >10 minutes after `associateAdminAccount`,
// `disassociateAdminAccount` fails with the typed
// `InvalidOperationException: Failed to offboard AWS Account <id> as an AWS
// Firewall Manager administrator account. Your AWS Organization is currently
// onboarding with AWS Firewall Manager and cannot be offboarded.`
// — far beyond the ungated polling budget. Set AWS_TEST_FMS=1 to run it; the
// destroy below is retried until onboarding settles and offboarding succeeds,
// leaving the organization exactly as found (no FMS admin). Note: association
// auto-creates the AWS-managed `AWSServiceRoleForFMS` service-linked role,
// which AWS retains after offboarding; reap it with
// `aws iam delete-service-linked-role --role-name AWSServiceRoleForFMS`
// (deletion only succeeds a few minutes after offboarding fully settles).
test.provider.skipIf(!process.env.AWS_TEST_FMS)(
  "lifecycle: designate the FMS admin account, then disassociate",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* AWSEnvironment.current;

      // Bail out (without failing) if some out-of-band actor already
      // designated a different FMS admin — we must not disassociate an admin
      // we don't own.
      const preExisting = yield* getAdmin;
      if (preExisting?.AdminAccount && preExisting.AdminAccount !== accountId) {
        yield* Effect.logInfo(
          `FMS admin already designated out-of-band (${preExisting.AdminAccount}) — lifecycle skipped`,
        );
        return;
      }

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AdminAccount("FmsAdmin", {});
        }),
      );
      expect(created.adminAccount).toBe(accountId);

      const live = yield* pinFms(fms.getAdminAccount({}));
      expect(live.AdminAccount).toBe(accountId);

      // Onboarding blocks offboarding for >10 minutes; the provider's delete
      // retries boundedly (~64s), so re-run destroy until it goes through.
      yield* stack
        .destroy()
        .pipe(
          Effect.retry({ schedule: Schedule.spaced("30 seconds"), times: 25 }),
        );
      // Offboarding propagates asynchronously — `getAdminAccount` keeps
      // returning the old admin for ~90s after disassociate succeeds.
      const after = yield* getAdmin.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (a) => a?.AdminAccount === undefined,
          times: 18,
        }),
      );
      expect(after?.AdminAccount).toBeUndefined();
    }),
  { timeout: 1_500_000 },
);
