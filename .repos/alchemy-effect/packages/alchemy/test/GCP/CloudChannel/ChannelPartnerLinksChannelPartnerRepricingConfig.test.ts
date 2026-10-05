import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cloudchannel from "@distilled.cloud/gcp/cloudchannel_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  logLevel,
  probeAccountName,
  runLifecycle,
  waitUntilPartnerRepricingGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const probePartner = `${probeAccountName}/channelPartnerLinks/alchemy-missing`;
const probeMonth = { year: 2099, month: 1, day: 0 };

test.provider(
  "getAccountsChannelPartnerLinksChannelPartnerRepricingConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cloudchannel.getAccountsChannelPartnerLinksChannelPartnerRepricingConfigs(
          {
            name: `${probePartner}/channelPartnerRepricingConfigs/alchemy-missing`,
          },
        ),
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
  "createAccountsChannelPartnerLinksChannelPartnerRepricingConfigs without Cloud Channel access fails with a typed entitlement error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cloudchannel.createAccountsChannelPartnerLinksChannelPartnerRepricingConfigs(
          {
            parent: probePartner,
            body: {
              repricingConfig: {
                effectiveInvoiceMonth: probeMonth,
                rebillingBasis: "COST_AT_LIST",
                adjustment: {
                  percentageAdjustment: { percentage: { value: "0.00" } },
                },
                entitlementGranularity: {
                  entitlement: `${probeAccountName}/customers/alchemy-missing/entitlements/alchemy-missing`,
                },
              },
            },
          },
        ),
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
  "create, update, and delete a channel partner repricing config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const partner =
        process.env.GOOGLE_CLOUDCHANNEL_PARTNER?.trim() ?? probePartner;
      const entitlement =
        process.env.GCP_CLOUDCHANNEL_ENTITLEMENT?.trim() ??
        `${probeAccountName}/customers/alchemy-missing/entitlements/alchemy`;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudChannel.ChannelPartnerLinksChannelPartnerRepricingConfig(
            "PartnerBill",
            {
              parent: partner,
              effectiveInvoiceMonth: probeMonth,
              adjustmentPercentage: "0.00",
              entitlement,
            },
          );
        }),
      );

      expect(created.name).toContain("/channelPartnerRepricingConfigs/");

      const fetched =
        yield* cloudchannel.getAccountsChannelPartnerLinksChannelPartnerRepricingConfigs(
          { name: created.name },
        );
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudChannel.ChannelPartnerLinksChannelPartnerRepricingConfig(
            "PartnerBill",
            {
              parent: partner,
              configId: created.configId,
              effectiveInvoiceMonth: probeMonth,
              adjustmentPercentage: "1.00",
              entitlement,
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);

      yield* stack.destroy();

      const gone = yield* waitUntilPartnerRepricingGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudchannel", "live"],
    timeout: 90_000,
  },
);
