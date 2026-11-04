import * as AWS from "@alchemy.run/aws";
import { CisScanConfiguration } from "@alchemy.run/aws/Inspector2/CisScanConfiguration";
import { Enabler } from "@alchemy.run/aws/Inspector2/Enabler";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Provider from "alchemy/Provider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const accountStatus = inspector2.batchGetAccountStatus({}).pipe(Effect.map((r) => r.accounts?.[0]));

const typeStatus = (account: inspector2.AccountState | undefined, key: "ec2" | "ecr" | "lambda") =>
  account?.resourceState?.[key]?.status;

class InspectorNotSettled extends Data.TaggedError("InspectorNotSettled")<{
  readonly expected: string;
  readonly status: string | undefined;
  readonly ec2: string | undefined;
}> {}

class InspectorRequestRejected extends Data.TaggedError("InspectorRequestRejected")<{
  readonly operation: "enable" | "disable";
  readonly failedAccounts: readonly inspector2.FailedAccount[];
}> {}

// Enablement transitions are asynchronous (ENABLING/DISABLING). Poll with a
// bounded budget (~50s) and check the terminal value — Effect.repeat returns
// its last success when the budget runs out even if `until` never held.
const waitForAccount = (expected: string, done: (account: inspector2.AccountState) => boolean) =>
  accountStatus.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (account) => account !== undefined && done(account),
      times: 10,
    }),
    Effect.flatMap((account) =>
      account !== undefined && done(account)
        ? Effect.succeed(account)
        : Effect.fail(
            new InspectorNotSettled({
              expected,
              status: account?.state?.status,
              ec2: typeStatus(account, "ec2"),
            }),
          ),
    ),
  );

// The scan type borrowed to satisfy the CIS APIs' "account is enabled" gate.
// CIS scans target EC2 instances, and any one enabled type flips the account
// status to ENABLED.
const CIS_SCAN_TYPE = "EC2";

// Disable exactly the scan type `withInspectorEnabled` turned on.
const restoreDisabled = (accountId: string) =>
  Effect.gen(function* () {
    // Disable is rejected with ENABLE_IN_PROGRESS until the enable settles.
    yield* waitForAccount(
      `${CIS_SCAN_TYPE} not ENABLING`,
      (account) => typeStatus(account, "ec2") !== "ENABLING",
    );
    const response = yield* inspector2.disable({
      accountIds: [accountId],
      resourceTypes: [CIS_SCAN_TYPE],
    });
    if (response.failedAccounts && response.failedAccounts.length > 0) {
      return yield* Effect.fail(
        new InspectorRequestRejected({
          operation: "disable",
          failedAccounts: response.failedAccounts,
        }),
      );
    }
    // Live disable can stay DISABLING for minutes. An accepted disable that is
    // still converging is not a leak; anything else is.
    yield* waitForAccount("DISABLED", (account) => account.state?.status === "DISABLED").pipe(
      Effect.catchTag("InspectorNotSettled", (e) =>
        e.ec2 === "DISABLING"
          ? Effect.logWarning(
              `Inspector ${CIS_SCAN_TYPE} disable accepted but still DISABLING after the wait budget — converging asynchronously`,
            )
          : Effect.fail(e),
      ),
    );
  });

// Capture-and-restore of the account/region enablement singleton for the
// enclosing scope. An account that is already ENABLED is left untouched; a
// DISABLED one gets CIS_SCAN_TYPE enabled, and only that type is disabled
// again when the scope closes.
const withInspectorEnabled = Effect.gen(function* () {
  const initial = yield* waitForAccount(
    "ENABLED or DISABLED",
    (account) => account.state?.status === "ENABLED" || account.state?.status === "DISABLED",
  );
  if (initial.state?.status === "ENABLED") {
    yield* Effect.logInfo(
      "Inspector already enabled — CIS lifecycle leaves the enablement untouched",
    );
    return;
  }

  const accountId = initial.accountId;
  yield* Effect.acquireRelease(
    inspector2.enable({ accountIds: [accountId], resourceTypes: [CIS_SCAN_TYPE] }).pipe(
      Effect.flatMap((response) =>
        response.failedAccounts && response.failedAccounts.length > 0
          ? Effect.fail(
              new InspectorRequestRejected({
                operation: "enable",
                failedAccounts: response.failedAccounts,
              }),
            )
          : Effect.void,
      ),
    ),
    () => restoreDisabled(accountId).pipe(Effect.orDie),
  );
  yield* waitForAccount(
    "ENABLED",
    (account) => account.state?.status === "ENABLED" && typeStatus(account, "ec2") === "ENABLED",
  );
});

test.provider(
  "account scan status is observable",
  () =>
    Effect.gen(function* () {
      const account = yield* accountStatus;
      expect(account?.accountId).toBeTruthy();
      expect(
        ["ENABLED", "ENABLING", "DISABLED", "DISABLING"].includes(typeStatus(account, "ec2") ?? ""),
      ).toBe(true);
      expect(
        ["ENABLED", "ENABLING", "DISABLED", "DISABLING"].includes(typeStatus(account, "ecr") ?? ""),
      ).toBe(true);
    }),
  { tags: ["provider:aws", "provider:aws:inspector2", "live"] },
);

// Inspector enablement is an account/region singleton. Every test that
// toggles it — or asserts behavior that depends on it — lives in this one
// sequential block so none of them observes another's enable window. Order:
// the disabled-account probe first (before any toggling), then the CIS
// lifecycle (which waits for its own disable to settle), then the Enabler
// lifecycle (which requires a fully DISABLED account).
describe.sequential("Inspector2 account enablement", () => {
  // The CIS scan APIs are hard-gated on Inspector enablement — a disabled
  // account gets a typed AccessDeniedException ("Invoking account is not
  // enabled."). This ungated probe pins that behavior.
  test.provider(
    "CIS scan APIs reject a non-enabled account (typed)",
    () =>
      Effect.gen(function* () {
        const account = (yield* inspector2.batchGetAccountStatus({})).accounts?.[0];
        if (account?.state?.status === "ENABLED") {
          yield* Effect.logInfo(
            "Inspector is enabled in this account — CIS APIs are accessible, probe not applicable",
          );
          return;
        }
        const result = yield* Effect.result(inspector2.listCisScanConfigurations({}));
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("AccessDeniedException");
        }
      }),
    { tags: ["provider:aws", "provider:aws:inspector2", "live"] },
  );

  // Full CIS scan configuration lifecycle. Self-sufficient: borrows Inspector
  // enablement for the duration of the test when the account is disabled.
  test.provider.skipIf(!process.env.INSPECTOR2_TEST_CIS)(
    "lifecycle: CIS scan configuration create, update, destroy",
    (stack) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* withInspectorEnabled;
          // Finalizers run in reverse order, so this teardown runs while
          // Inspector is still enabled — the harness's own trailing destroy
          // runs after the scope disabled it, when the CIS delete API rejects.
          yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));

          yield* stack.destroy();

          const deploy = (props: { securityLevel: "LEVEL_1" | "LEVEL_2"; timeOfDay: string }) =>
            stack.deploy(
              Effect.gen(function* () {
                const cis = yield* CisScanConfiguration("NightlyCis", {
                  securityLevel: props.securityLevel,
                  schedule: {
                    daily: { startTime: { timeOfDay: props.timeOfDay, timezone: "UTC" } },
                  },
                  targets: {
                    accountIds: ["SELF"],
                    targetResourceTags: { AlchemyCisTest: ["true"] },
                  },
                  tags: { env: "test" },
                });
                return {
                  scanConfigurationArn: cis.scanConfigurationArn,
                  scanName: cis.scanName,
                  securityLevel: cis.securityLevel,
                };
              }),
            );

          const created = yield* deploy({ securityLevel: "LEVEL_1", timeOfDay: "02:00" });
          // arn:aws:inspector2:<region>:<account>:owner/<owner>/cis-configuration/<id>
          expect(created.scanConfigurationArn).toContain("cis-configuration");
          expect(created.securityLevel).toBe("LEVEL_1");

          const byArn = () =>
            inspector2
              .listCisScanConfigurations({
                filterCriteria: {
                  scanConfigurationArnFilters: [
                    { comparison: "EQUALS", value: created.scanConfigurationArn },
                  ],
                },
              })
              .pipe(Effect.map((r) => r.scanConfigurations?.[0]));

          const live = yield* byArn();
          expect(live?.securityLevel).toBe("LEVEL_1");
          expect(live?.schedule?.daily?.startTime.timeOfDay).toBe("02:00");

          // Canonical list() coverage.
          const provider = yield* Provider.findProvider(CisScanConfiguration);
          const all = yield* provider.list();
          expect(all.some((c) => c.scanConfigurationArn === created.scanConfigurationArn)).toBe(
            true,
          );

          // Update in place — the ARN is stable.
          const updated = yield* deploy({ securityLevel: "LEVEL_2", timeOfDay: "03:30" });
          expect(updated.scanConfigurationArn).toBe(created.scanConfigurationArn);
          expect(updated.securityLevel).toBe("LEVEL_2");
          const liveUpdated = yield* byArn();
          expect(liveUpdated?.schedule?.daily?.startTime.timeOfDay).toBe("03:30");

          // Destroy — the configuration is gone.
          yield* stack.destroy();
          expect(yield* byArn()).toBeUndefined();
        }),
      ),
    { tags: ["provider:aws", "provider:aws:inspector2", "live"], timeout: 240_000 },
  );

  // This test only runs when Inspector is fully disabled — it must never
  // disable scan types the user already enabled (capture-and-restore safety).
  test.provider.skipIf(!process.env.INSPECTOR2_TEST_ENABLER)(
    "lifecycle: enable EC2/ECR, add LAMBDA, disable",
    (stack) =>
      Effect.gen(function* () {
        const preexisting = yield* accountStatus;
        if (preexisting && preexisting.state?.status !== "DISABLED") {
          yield* Effect.logInfo(
            `Inspector already enabled (${preexisting.state?.status}) — skipping destructive lifecycle test`,
          );
          return;
        }

        yield* stack.destroy();

        // Create — enable EC2 + ECR scanning.
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Enabler("Inspector", { resourceTypes: ["EC2", "ECR"] });
          }),
        );
        expect(created.accountId).toBeTruthy();
        expect(created.resourceTypes.sort()).toEqual(["EC2", "ECR"]);

        // Out-of-band verification.
        const live = yield* accountStatus;
        expect(typeStatus(live, "ec2")).toBe("ENABLED");
        expect(typeStatus(live, "ecr")).toBe("ENABLED");

        // Canonical list() coverage.
        const provider = yield* Provider.findProvider(Enabler);
        const all = yield* provider.list();
        expect(all.some((e) => e.accountId === created.accountId)).toBe(true);

        // Update — add LAMBDA scanning.
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Enabler("Inspector", { resourceTypes: ["EC2", "ECR", "LAMBDA"] });
          }),
        );
        expect(updated.resourceTypes.sort()).toEqual(["EC2", "ECR", "LAMBDA"]);
        const afterUpdate = yield* accountStatus;
        expect(typeStatus(afterUpdate, "lambda")).toBe("ENABLED");

        // Destroy — Inspector scanning is disabled again.
        yield* stack.destroy();
        const after = yield* accountStatus;
        expect(typeStatus(after, "ec2")).not.toBe("ENABLED");
        expect(typeStatus(after, "ecr")).not.toBe("ENABLED");
        expect(typeStatus(after, "lambda")).not.toBe("ENABLED");
      }),
    { tags: ["provider:aws", "provider:aws:inspector2", "live"], timeout: 240_000 },
  );
});
