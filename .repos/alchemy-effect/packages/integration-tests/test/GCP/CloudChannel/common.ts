import * as cloudchannel from "@distilled.cloud/gcp/cloudchannel_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Cloud Channel needs a reseller/distributor account and credentials with the
// apps.order scope; the service account profile is rejected with Forbidden:
// "Request had insufficient authentication scopes." Set
// GOOGLE_CLOUDCHANNEL_ACCOUNT to the reseller account to run the lifecycles.
export const runLifecycle = !!process.env.GOOGLE_CLOUDCHANNEL_ACCOUNT?.trim();

export const probeAccount = process.env.GOOGLE_CLOUDCHANNEL_ACCOUNT?.trim() || "C00000000";

export const probeAccountName = probeAccount.startsWith("accounts/")
  ? probeAccount
  : `accounts/${probeAccount}`;

export const probePostalAddress: cloudchannel.GoogleTypePostalAddress = {
  regionCode: "US",
  postalCode: "94105",
  administrativeArea: "CA",
  locality: "San Francisco",
  addressLines: ["100 Market Street"],
};

export const probeCustomerBody = {
  orgDisplayName: "Alchemy Cloudchannel Probe",
  domain: "alchemy-cloudchannel-probe.example.com",
  orgPostalAddress: probePostalAddress,
  primaryContactInfo: {
    firstName: "Alchemy",
    lastName: "Probe",
    email: "admin@alchemy-cloudchannel-probe.example.com",
  },
} satisfies cloudchannel.GoogleCloudChannelV1Customer;

export const waitUntilCustomerGone = (name: string) =>
  cloudchannel.getAccountsCustomers({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

export const waitUntilPartnerCustomerGone = (name: string) =>
  cloudchannel.getAccountsChannelPartnerLinksCustomers({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

export const waitUntilCustomerRepricingGone = (name: string) =>
  cloudchannel.getAccountsCustomersCustomerRepricingConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

export const waitUntilPartnerRepricingGone = (name: string) =>
  cloudchannel.getAccountsChannelPartnerLinksChannelPartnerRepricingConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );
