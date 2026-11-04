import * as marketplace from "@distilled.cloud/gcp/authorizedbuyersmarketplace_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const probeParent = "buyers/1/clients/1";
export const probeName = `${probeParent}/users/0`;

const expandParent = (value: string) => {
  const trimmed = value.replace(/\/+$/, "").trim();
  if (trimmed.length === 0) return trimmed;
  if (trimmed.includes("/clients/")) {
    return trimmed.startsWith("buyers/") ? trimmed : `buyers/${trimmed}`;
  }
  return trimmed;
};

const envParent = process.env.GCP_AUTHORIZEDBUYERSMARKETPLACE_PARENT?.trim();
const envBuyer = process.env.GCP_AUTHORIZEDBUYERSMARKETPLACE_BUYER_ID?.trim();
const envClient = process.env.GCP_AUTHORIZEDBUYERSMARKETPLACE_CLIENT_ID?.trim();

// Full lifecycle needs an Authorized Buyers account with a client; set
// GCP_AUTHORIZEDBUYERSMARKETPLACE_PARENT (or _BUYER_ID + _CLIENT_ID).
export const lifecycleParent = envParent
  ? expandParent(envParent)
  : envBuyer && envClient
    ? expandParent(`${envBuyer}/clients/${envClient}`)
    : undefined;

export const waitUntilGone = (name: string) =>
  marketplace.getBuyersClientsUsers({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );
