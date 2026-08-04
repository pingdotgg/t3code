import * as AWS from "@/AWS";
import { Enabler } from "@/AWS/Inspector2/Enabler.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as inspector2 from "@distilled.cloud/aws/inspector2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const accountStatus = inspector2
  .batchGetAccountStatus({})
  .pipe(Effect.map((r) => r.accounts?.[0]));

const typeStatus = (
  account: inspector2.AccountState | undefined,
  key: "ec2" | "ecr" | "lambda",
) => account?.resourceState?.[key]?.status;

test.provider("account scan status is observable", () =>
  Effect.gen(function* () {
    const account = yield* accountStatus;
    expect(account?.accountId).toBeTruthy();
    expect(
      ["ENABLED", "ENABLING", "DISABLED", "DISABLING"].includes(
        typeStatus(account, "ec2") ?? "",
      ),
    ).toBe(true);
    expect(
      ["ENABLED", "ENABLING", "DISABLED", "DISABLING"].includes(
        typeStatus(account, "ecr") ?? "",
      ),
    ).toBe(true);
  }),
);

// The Inspector enabler is an account/region singleton. This test only runs
// when Inspector is fully disabled — it must never disable scan types the user
// already enabled (capture-and-restore safety).
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
          return yield* Enabler("Inspector", {
            resourceTypes: ["EC2", "ECR"],
          });
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
          return yield* Enabler("Inspector", {
            resourceTypes: ["EC2", "ECR", "LAMBDA"],
          });
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
  { timeout: 240_000 },
);
