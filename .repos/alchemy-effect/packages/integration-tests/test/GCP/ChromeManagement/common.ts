import * as chromemanagement from "@distilled.cloud/gcp/chromemanagement_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const toCustomerName = (value: string) => {
  const trimmed = value.replace(/\/+$/, "").trim();
  if (trimmed.length === 0) return "";
  const idx = trimmed.lastIndexOf("/customers/");
  if (idx >= 0) {
    const id = trimmed.slice(idx + "/customers/".length).split("/")[0] ?? "";
    return id.length > 0 ? `customers/${id}` : "";
  }
  if (trimmed.startsWith("customers/")) {
    const id = trimmed.slice("customers/".length).split("/")[0] ?? "";
    return id.length > 0 ? `customers/${id}` : trimmed;
  }
  return `customers/${lastSegment(trimmed)}`;
};

export const customerName = (() => {
  const raw =
    process.env.GCP_CHROMEMANAGEMENT_CUSTOMER?.trim() ||
    process.env.GCP_CHROMEMANAGEMENT_CUSTOMER_ID?.trim();
  return raw ? toCustomerName(raw) : "customers/my_customer";
})();

// Needs a Chrome Enterprise customer the credentials administer
// (GCP_CHROMEMANAGEMENT_CUSTOMER); the service-account token fails with
// `InsufficientScopes` ("Request had insufficient authentication scopes.")
export const runLifecycle = !!(
  process.env.GCP_CHROMEMANAGEMENT_CUSTOMER?.trim() ||
  process.env.GCP_CHROMEMANAGEMENT_CUSTOMER_ID?.trim()
);

export const probeParent = "customers/0";
export const probeName = `${probeParent}/connectorConfigs/alchemy-missing`;

export const waitUntilGone = (name: string) =>
  chromemanagement.getCustomersConnectorConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );
