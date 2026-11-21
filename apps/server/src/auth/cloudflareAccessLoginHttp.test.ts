import { assert, it } from "@effect/vitest";
import { CLOUDFLARE_ACCESS_APP_CALLBACK_URL } from "@t3tools/shared/cloudflareAccessLogin";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http";

import * as CloudflareAccessLogin from "./CloudflareAccessLogin.ts";
import { makeCloudflareAccessLoginHandler } from "./cloudflareAccessLoginHttp.ts";
import { ServerAuthPairingLinkCreationError } from "./EnvironmentAuth.ts";

const CREDENTIAL = "pairing-credential-123";

const requestWithQuery = (query: string) =>
  HttpServerRequest.fromWeb(
    new Request(`http://localhost/api/auth/cloudflare-access?${query}`, {
      headers: {
        "cf-access-jwt-assertion": "signed.assertion.jwt",
        host: "evil.example",
        "x-forwarded-host": "evil.example",
      },
    }),
  );

const respond = (
  login: CloudflareAccessLogin.CloudflareAccessLogin["Service"]["login"],
  query = "redirect=https://evil.example",
) =>
  makeCloudflareAccessLoginHandler(CloudflareAccessLogin.CloudflareAccessLogin.of({ login }))(
    requestWithQuery(query),
  );

const issue = () => Effect.succeed({ credential: CREDENTIAL, expiresAt: DateTime.nowUnsafe() });

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

it.effect("sends client=app to this build's app scheme, and anything else to /pair", () =>
  Effect.gen(function* () {
    const cases = [
      ["client=app", `${CLOUDFLARE_ACCESS_APP_CALLBACK_URL}#token=${CREDENTIAL}`],
      ["client=app&redirect=evil://x", `${CLOUDFLARE_ACCESS_APP_CALLBACK_URL}#token=${CREDENTIAL}`],
      ["client=evil://steal", `/pair#token=${CREDENTIAL}`],
      ["client=APP", `/pair#token=${CREDENTIAL}`],
      ["client=", `/pair#token=${CREDENTIAL}`],
    ] as const;
    for (const [query, location] of cases) {
      const response = yield* respond(issue, query);
      assert.strictEqual(response.status, 302, query);
      assert.strictEqual(response.headers.location, location, query);
      assert.strictEqual(response.headers["cache-control"], "no-store", query);
      assert.strictEqual(response.headers["referrer-policy"], "no-referrer", query);
    }
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
