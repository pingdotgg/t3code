import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const enterpriseId =
  process.env.GCP_ANDROIDENTERPRISE_ENTERPRISE_ID?.trim() ||
  process.env.GCP_ANDROID_ENTERPRISE_ID?.trim();

// Needs an EMM-bound managed Google Play enterprise
// (GCP_ANDROIDENTERPRISE_ENTERPRISE_ID); EMM access is partner-allowlisted.
export const runLifecycle = !!enterpriseId;

export const probeEnterpriseId = enterpriseId ?? "alchemy-missing-enterprise";
