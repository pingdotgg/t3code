import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const customer =
  process.env.GCP_CLOUDIDENTITY_CUSTOMER?.trim() || "customers/my_customer";

export const domain = process.env.GCP_CLOUDIDENTITY_DOMAIN?.trim() || undefined;

export const memberEmail =
  process.env.GCP_CLOUDIDENTITY_MEMBER?.trim() || undefined;

// Cloud Identity needs a Workspace/Cloud Identity customer: the testing
// project's creates fail with ServiceDisabled "Cloud Identity API has not been used
// in project ... before or it is disabled" (Device: "Request had insufficient
// authentication scopes."). Set GCP_TEST_CLOUDIDENTITY=1 plus the
// GCP_CLOUDIDENTITY_* fixtures on an entitled customer.
export const runLifecycle =
  !process.env.FAST && !!process.env.GCP_TEST_CLOUDIDENTITY;

export const runGroupLifecycle = runLifecycle && !!domain;

export const runMembershipLifecycle = runGroupLifecycle && !!memberEmail;
