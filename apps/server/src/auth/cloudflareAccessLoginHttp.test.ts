import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http";

import * as CloudflareAccessLogin from "./CloudflareAccessLogin.ts";
import { makeCloudflareAccessLoginHandler } from "./cloudflareAccessLoginHttp.ts";
import { ServerAuthPairingLinkCreationError } from "./EnvironmentAuth.ts";

const CREDENTIAL = "pairing-credential-123";

const request = HttpServerRequest.fromWeb(
  new Request("http://localhost/api/auth/cloudflare-access?redirect=https://evil.example", {
    headers: { "cf-access-jwt-assertion": "signed.assertion.jwt" },
  }),
);

const respond = (login: CloudflareAccessLogin.CloudflareAccessLogin["Service"]["login"]) =>
  makeCloudflareAccessLoginHandler(CloudflareAccessLogin.CloudflareAccessLogin.of({ login }))(
    request,
  );

it.effect("redirects to /pair with the credential only in the fragment", () =>
  Effect.gen(function* () {
    const assertions: Array<string | undefined> = [];
    const response = yield* respond((assertion) =>
      Effect.sync(() => {
        assertions.push(assertion);
        return { credential: CREDENTIAL, expiresAt: DateTime.nowUnsafe() };
      }),
    );
    assert.deepStrictEqual(assertions, ["signed.assertion.jwt"]);
    assert.strictEqual(response.status, 302);
    assert.strictEqual(response.headers.location, `/pair#token=${CREDENTIAL}`);
    assert.strictEqual(response.headers["cache-control"], "no-store");
    assert.strictEqual(response.headers["referrer-policy"], "no-referrer");
  }),
);

it.effect("maps every refusal to a status that reveals nothing", () =>
  Effect.gen(function* () {
    const cases = [
      [new CloudflareAccessLogin.CloudflareAccessLoginDisabledError(), 404],
      [new CloudflareAccessLogin.CloudflareAccessAssertionMissingError(), 401],
      [new CloudflareAccessLogin.CloudflareAccessAssertionInvalidError({ reason: "x" }), 401],
      [new CloudflareAccessLogin.CloudflareAccessEmailNotAllowedError({ email: "a@b.c" }), 403],
      [new CloudflareAccessLogin.CloudflareAccessKeysUnavailableError({ cause: "down" }), 503],
      [new ServerAuthPairingLinkCreationError({ cause: "sqlite" }), 500],
    ] as const;
    for (const [error, status] of cases) {
      const response = yield* respond(() => Effect.fail(error));
      assert.strictEqual(response.status, status, error._tag);
      assert.isUndefined(response.headers.location, error._tag);
      assert.strictEqual(response.headers["cache-control"], "no-store", error._tag);
    }
  }),
);
