import { expect } from "@effect/vitest";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { apnsDeliverySmoke } from "../smoke/apnsDelivery.ts";

const requiredApnsCredentialEnv = [
  "APNS_TEAM_ID",
  "APNS_KEY_ID",
  "APNS_BUNDLE_ID",
  "APNS_PRIVATE_KEY",
] as const;

function hasEnvValue(name: string): boolean {
  return (process.env[name]?.trim().length ?? 0) > 0;
}

const smokeKind = process.env.APNS_SMOKE_KIND?.trim() ?? "live_activity";
const hasApnsSmokeConfig =
  requiredApnsCredentialEnv.every(hasEnvValue) &&
  (smokeKind === "push_notification"
    ? hasEnvValue("APNS_PUSH_TOKEN")
    : hasEnvValue("APNS_LIVE_ACTIVITY_TOKEN"));

const { test } = Test.make({
  providers: Layer.empty,
  stage: "relay-apns-live-smoke",
});

test.skipIf(!hasApnsSmokeConfig)(
  "delivers a real APNs smoke notification with configured provider credentials",
  Effect.gen(function* () {
    const result = yield* apnsDeliverySmoke;

    expect(result.ok).toBe(true);
    expect(result.status).toBeGreaterThanOrEqual(200);
    expect(result.status).toBeLessThan(300);
  }),
);
