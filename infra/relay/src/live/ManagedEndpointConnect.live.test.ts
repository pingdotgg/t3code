import * as Test from "alchemy/Test/Vitest";
import * as Layer from "effect/Layer";

import { managedEndpointConnectSmoke } from "../smoke/managedEndpointConnect.ts";

const relayUrl = process.env.T3_RELAY_URL?.trim() ?? "";
const environmentId = process.env.T3_ENVIRONMENT_ID?.trim() ?? "";
const clerkJwt = process.env.CLERK_JWT?.trim() ?? "";

const { test } = Test.make({
  providers: Layer.empty,
  stage: "relay-managed-endpoint-live-smoke",
});

test.skipIf(relayUrl.length === 0 || environmentId.length === 0 || clerkJwt.length === 0)(
  "deployed relay connects a Clerk user to a linked managed endpoint",
  managedEndpointConnectSmoke,
);
