import * as GCP from "@/GCP";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as cloudchannel from "@distilled.cloud/gcp/cloudchannel_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  logLevel,
  probeAccountName,
  runLifecycle,
  waitUntilCustomerRepricingGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const probeParent = `${probeAccountName}/customers/alchemy-missing`;
const probeMonth = { year: 2099, month: 1, day: 0 };

test.provider(
  "getAccountsCustomersCustomerRepricingConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cloudchannel.getAccountsCustomersCustomerRepricingConfigs({
          name: `${probeParent}/customerRepricingConfigs/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudchannel", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "createAccountsCustomersCustomerRepricingConfigs without Cloud Channel access fails with a typed entitlement error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cloudchannel.createAccountsCustomersCustomerRepricingConfigs({
          parent: probeParent,
          body: {
            repricingConfig: {
              effectiveInvoiceMonth: probeMonth,
              rebillingBasis: "COST_AT_LIST",
              adjustment: {
                percentageAdjustment: { percentage: { value: "0.00" } },
              },
              entitlementGranularity: {
                entitlement: `${probeParent}/entitlements/alchemy-missing`,
              },
            },
          },
        }),
      );
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudchannel", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a customer repricing config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const entitlement = process.env.GCP_CLOUDCHANNEL_ENTITLEMENT?.trim();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const customer = yield* GCP.CloudChannel.Customer("AcmeBill", {
            parent: probeAccountName,
            orgDisplayName: "Acme Billing",
          });
          const config =
            yield* GCP.CloudChannel.CustomersCustomerRepricingConfig(
              "AcmeRule",
              {
                parent: customer.name,
                effectiveInvoiceMonth: probeMonth,
                adjustmentPercentage: "0.00",
                entitlement:
                  entitlement ??
                  Output.interpolate`${customer.name}/entitlements/alchemy`,
              },
            );
          return { customer, config };
        }),
      );

      expect(created.config.name).toContain("/customerRepricingConfigs/");
      expect(created.config.parent).toEqual(created.customer.name);

      const fetched =
        yield* cloudchannel.getAccountsCustomersCustomerRepricingConfigs({
          name: created.config.name,
        });
      expect(fetched.name).toEqual(created.config.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const customer = yield* GCP.CloudChannel.Customer("AcmeBill", {
            parent: probeAccountName,
            customerId: created.customer.customerId,
            orgDisplayName: "Acme Billing",
            domain: created.customer.domain,
          });
          const config =
            yield* GCP.CloudChannel.CustomersCustomerRepricingConfig(
              "AcmeRule",
              {
                parent: customer.name,
                configId: created.config.configId,
                effectiveInvoiceMonth: probeMonth,
                adjustmentPercentage: "1.00",
                entitlement:
                  entitlement ??
                  Output.interpolate`${customer.name}/entitlements/alchemy`,
              },
            );
          return { customer, config };
        }),
      );

      expect(updated.config.name).toEqual(created.config.name);

      yield* stack.destroy();

      const gone = yield* waitUntilCustomerRepricingGone(created.config.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudchannel", "live"],
    timeout: 90_000,
  },
);
