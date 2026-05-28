import { expect } from "@effect/vitest";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpBody } from "effect/unstable/http";

import { RelayHealthResponse } from "@t3tools/contracts/relay";

const relayUrl = process.env.T3_RELAY_URL?.trim().replace(/\/+$/g, "") ?? "";

const { test } = Test.make({
  providers: Layer.empty,
  stage: "relay-live-smoke",
});

const decodeRelayHealthResponse = Schema.decodeUnknownEffect(RelayHealthResponse);
const encodeJson = Schema.encodeEffect(Schema.UnknownFromJsonString);

test.skipIf(relayUrl.length === 0)(
  "deployed relay serves health through the real Worker and database",
  Effect.gen(function* () {
    const response = yield* HttpClient.get(`${relayUrl}/health`);
    expect(response.status).toBe(200);

    const body = yield* response.json.pipe(Effect.flatMap(decodeRelayHealthResponse));
    expect(body).toEqual({ ok: true, service: "relay" });
  }),
);

test.skipIf(relayUrl.length === 0)(
  "deployed relay rejects unauthenticated mobile token registration",
  Effect.gen(function* () {
    const body = yield* encodeJson({
      deviceId: "live-smoke-device",
      platform: "ios",
      iosMajorVersion: 18,
      preferences: {
        notificationsEnabled: true,
        liveActivitiesEnabled: true,
        notifyOnApproval: true,
        notifyOnInput: true,
        notifyOnCompletion: true,
        notifyOnFailure: true,
      },
    });
    const response = yield* HttpClient.post(`${relayUrl}/v1/mobile/devices`, {
      body: HttpBody.text(body, "application/json"),
    });

    expect(response.status).toBe(401);
  }),
);

test.skipIf(relayUrl.length === 0)(
  "deployed relay rejects unauthenticated mobile device unregistration",
  Effect.gen(function* () {
    const response = yield* HttpClient.del(`${relayUrl}/v1/mobile/devices/live-smoke-device`);

    expect(response.status).toBe(401);
  }),
);
