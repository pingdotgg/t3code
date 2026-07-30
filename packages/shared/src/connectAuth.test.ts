import { assert, it } from "@effect/vitest";

import {
  buildConnectAuthorizeRequestUrl,
  checkConnectAuthCode,
  connectCallbackUrl,
  encodeConnectAuthCode,
  readConnectAuthorizeRequest,
} from "./connectAuth.ts";

it("keeps the headless OAuth state and challenge in the browser-only URL fragment", () => {
  const url = new URL(
    buildConnectAuthorizeRequestUrl({
      hostedAppUrl: "https://app.example.test",
      state: "expected-state",
      challenge: "pkce-challenge",
    }),
  );

  assert.equal(url.pathname, "/connect");
  assert.equal(url.search, "");
  assert.deepEqual(readConnectAuthorizeRequest(url), {
    state: "expected-state",
    challenge: "pkce-challenge",
  });
  assert.equal(
    connectCallbackUrl("https://app.example.test"),
    "https://app.example.test/connect/callback",
  );
});

it("rejects malformed and cross-request authorization codes", () => {
  assert.equal(
    checkConnectAuthCode("not-a-code", "expected-state"),
    "That does not look like a T3 Connect code. Copy the full code.",
  );
  assert.equal(
    checkConnectAuthCode("clerk-code.other-state", "expected-state"),
    "That code belongs to a different connect request. Open the URL above and try again.",
  );
  assert.deepEqual(
    checkConnectAuthCode(
      encodeConnectAuthCode({ code: "clerk-code", state: "expected-state" }),
      "expected-state",
    ),
    { code: "clerk-code", state: "expected-state" },
  );
});
