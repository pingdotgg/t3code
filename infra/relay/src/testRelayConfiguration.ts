import * as Redacted from "effect/Redacted";

import type * as RelayConfiguration from "./Config.ts";

export function testRelayConfiguration(
  overrides: Partial<RelayConfiguration.RelayConfiguration["Service"]> = {},
): RelayConfiguration.RelayConfiguration["Service"] {
  return {
    relayIssuer: "https://relay.example.test",
    apns: {
      environment: "sandbox",
      teamId: "team-id",
      keyId: "key-id",
      privateKey: Redacted.make("apns-private-key"),
      bundleId: "com.t3tools.t3code.dev",
    },
    fcm: null,
    fcmDeliveryEnabled: false,
    clerkSecretKey: Redacted.make("clerk-secret"),
    clerkPublishableKey: "pk_test_test",
    clerkJwtAudience: "t3-code-relay",
    apnsDeliveryJobSigningSecret: Redacted.make("apns-job-secret"),
    fcmDeliveryJobSigningSecret: Redacted.make("fcm-job-secret"),
    cloudMintPrivateKey: Redacted.make("cloud-private-key"),
    cloudMintPublicKey: "cloud-public-key",
    managedEndpointBaseDomain: undefined,
    managedEndpointNamespace: undefined,
    ...overrides,
  };
}
