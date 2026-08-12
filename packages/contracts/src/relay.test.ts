import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";

import { RelayApi, RelayWebPushRegistrationRequest } from "./relay.ts";

describe("RelayApi security", () => {
  it("describes DPoP access tokens using the HTTP DPoP authorization scheme", () => {
    const document = OpenApi.fromApi(RelayApi);

    expect(document.components.securitySchemes?.relayDpop).toEqual({
      type: "http",
      scheme: "DPoP",
      description: "DPoP-bound access token. Requests must also include the DPoP proof JWT header.",
    });
  });
});

describe("RelayWebPushRegistrationRequest", () => {
  const decode = Schema.decodeUnknownSync(RelayWebPushRegistrationRequest);
  const registration = {
    subscriptionId: "subscription",
    label: "Web browser",
    subscription: {
      endpoint: "https://push.example.test/subscription",
      expirationTime: null,
      keys: { p256dh: "p256dh", auth: "auth" },
    },
    preferences: {
      notifyOnApproval: true,
      notifyOnCompletion: true,
      notifyOnFailure: true,
      soundEnabled: true,
    },
  };

  it("accepts secure standards-based push endpoints", () => {
    expect(decode(registration)).toEqual(registration);
  });

  it("rejects insecure or malformed push endpoints", () => {
    expect(() =>
      decode({
        ...registration,
        subscription: { ...registration.subscription, endpoint: "http://localhost/push" },
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...registration,
        subscription: { ...registration.subscription, endpoint: "not a URL" },
      }),
    ).toThrow();
  });
});
