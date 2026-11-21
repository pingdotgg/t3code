import {
  CLOUDFLARE_ACCESS_APP_CALLBACK_URL,
  CLOUDFLARE_ACCESS_LOGIN_PATH,
} from "@t3tools/shared/cloudflareAccessLogin";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as CloudflareAccessLogin from "./CloudflareAccessLogin.ts";

const ASSERTION_HEADER = "cf-access-jwt-assertion";

// The redirect carries a pairing credential: keep it out of caches and Referer.
const RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

// Refusals say nothing about the configuration or why verification failed.
const refusal = (status: number, body: string) =>
  HttpServerResponse.text(body, { status, headers: RESPONSE_HEADERS });

const refused = (status: number, body: string, error: { readonly _tag: string }) =>
  Effect.logWarning("Cloudflare Access sign-in refused", {
    errorTag: error._tag,
    ...("reason" in error ? { reason: error.reason } : {}),
    ...("email" in error ? { email: error.email } : {}),
  }).pipe(Effect.as(refusal(status, body)));

// Only this build's own app scheme or the relative /pair page; nothing in the request picks the
// destination beyond choosing between the two.
const credentialDestination = (request: HttpServerRequest.HttpServerRequest) => {
  const client = new URL(request.url, "http://localhost").searchParams.get("client");
  return client === "app" ? CLOUDFLARE_ACCESS_APP_CALLBACK_URL : "/pair";
};

export const makeCloudflareAccessLoginHandler =
  (service: CloudflareAccessLogin.CloudflareAccessLogin["Service"]) =>
  (request: HttpServerRequest.HttpServerRequest) =>
    service.login(request.headers[ASSERTION_HEADER]).pipe(
      Effect.map(({ credential }) =>
        // Never built from Host or forwarded headers; the fragment keeps the credential out of
        // server logs, and /pair strips it after reading.
        HttpServerResponse.redirect(
          `${credentialDestination(request)}#${new URLSearchParams([["token", credential]])}`,
          {
            status: 302,
            headers: RESPONSE_HEADERS,
          },
        ),
      ),
      Effect.catchTags({
        CloudflareAccessLoginDisabledError: () => Effect.succeed(refusal(404, "Not Found")),
        CloudflareAccessAssertionMissingError: (error) => refused(401, "Sign-in required.", error),
        CloudflareAccessAssertionInvalidError: (error) => refused(401, "Sign-in failed.", error),
        CloudflareAccessEmailNotAllowedError: (error) =>
          refused(403, "This account is not allowed to sign in.", error),
        CloudflareAccessKeysUnavailableError: (error) =>
          refused(503, "Sign-in is unavailable. Try again shortly.", error),
        ManagedPolicyRefusedError: (error) =>
          refused(403, "This server does not accept new devices.", error),
      }),
      Effect.catch((error) =>
        Effect.logError("Cloudflare Access sign-in failed", { errorTag: error._tag }).pipe(
          Effect.as(refusal(500, "Sign-in failed.")),
        ),
      ),
    );

export const layer = HttpRouter.use(
  Effect.fnUntraced(function* (router) {
    const service = yield* CloudflareAccessLogin.CloudflareAccessLogin;
    yield* router.add(
      "GET",
      CLOUDFLARE_ACCESS_LOGIN_PATH,
      makeCloudflareAccessLoginHandler(service),
    );
  }),
).pipe(Layer.provide(CloudflareAccessLogin.layer));
