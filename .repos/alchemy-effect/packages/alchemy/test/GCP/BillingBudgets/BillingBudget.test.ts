import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as billingbudgets from "@distilled.cloud/gcp/billingbudgets_v1";
import * as cloudbilling from "@distilled.cloud/gcp/cloudbilling_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  billingbudgets.getBillingAccountsBudgets({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "BudgetNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const billingAccountId = () => {
  const fromEnv = process.env.GOOGLE_BILLING_ACCOUNT;
  if (fromEnv && fromEnv.length > 0) {
    return Effect.succeed(
      fromEnv.startsWith("billingAccounts/")
        ? fromEnv.slice("billingAccounts/".length)
        : fromEnv,
    );
  }
  return GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      cloudbilling.getBillingInfoProjects({ name: `projects/${project}` }),
    ),
    Effect.map(
      (info) => (info.billingAccountName ?? "").split("/").pop() ?? "",
    ),
  );
};

test.provider(
  "getBillingAccountsBudgets on a missing budget fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const account = yield* billingAccountId();
      const error = yield* Effect.flip(
        billingbudgets.getBillingAccountsBudgets({
          name: `billingAccounts/${account}/budgets/00000000-0000-0000-0000-000000000000`,
        }),
      );
      expect(error._tag).toEqual("BudgetNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:billingbudgets", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a billing budget",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const account = yield* billingAccountId();
      expect(account.length).toBeGreaterThan(0);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BillingBudgets.BillingBudget("Spend", {
            billingAccountId: account,
            displayName: "cap",
            amount: {
              specifiedAmount: { currencyCode: "USD", units: "10" },
            },
            budgetFilter: {
              projects: [`projects/${project}`],
              calendarPeriod: "MONTH",
            },
            thresholdRules: [
              { thresholdPercent: 0.5, spendBasis: "CURRENT_SPEND" },
            ],
          });
        }),
      );

      expect(created.name).toContain(`/budgets/`);
      expect(created.budgetId).toEqual(expect.any(String));
      expect(created.billingAccountId).toEqual(account);
      expect(created.displayName).toEqual("cap");
      expect(created.amount?.specifiedAmount?.units).toEqual("10");
      expect(created.thresholdRules[0]?.thresholdPercent).toEqual(0.5);

      const fetched = yield* billingbudgets.getBillingAccountsBudgets({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual("cap");
      expect(fetched.amount?.specifiedAmount?.units).toEqual("10");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BillingBudgets.BillingBudget("Spend", {
            billingAccountId: account,
            displayName: "cap",
            amount: {
              specifiedAmount: { currencyCode: "USD", units: "25" },
            },
            budgetFilter: {
              projects: [`projects/${project}`],
              calendarPeriod: "MONTH",
            },
            thresholdRules: [
              { thresholdPercent: 0.5, spendBasis: "CURRENT_SPEND" },
              { thresholdPercent: 0.9, spendBasis: "CURRENT_SPEND" },
            ],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.budgetId).toEqual(created.budgetId);
      expect(updated.amount?.specifiedAmount?.units).toEqual("25");
      expect(updated.thresholdRules.length).toEqual(2);

      const fetchedUpdate = yield* billingbudgets.getBillingAccountsBudgets({
        name: created.name,
      });
      expect(fetchedUpdate.amount?.specifiedAmount?.units).toEqual("25");
      expect(fetchedUpdate.thresholdRules?.length).toEqual(2);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:billingbudgets", "live"],
    timeout: 90_000,
  },
);
