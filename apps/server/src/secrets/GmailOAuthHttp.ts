import * as Effect from "effect/Effect";
import { HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { callbackPath, GmailOAuth } from "./GmailOAuth.ts";

const headers = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
};

export const routeLayer = HttpRouter.add(
  "GET",
  callbackPath,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const flows = yield* GmailOAuth;
    // This route needs no host, redirect target, or authenticated browser session. The
    // state can only deliver a code to the waiting session; it cannot complete enrollment.
    const result =
      request.url.startsWith(`${callbackPath}?`) && request.url.length <= 8192
        ? flows.receive(new URLSearchParams(request.url.slice(callbackPath.length + 1)))
        : "inactive";
    return HttpServerResponse.text(
      result === "accepted"
        ? "Google approval received. Return to Hyakki, enter your vault PIN, and select Finish connection to save the Gmail connection. You can close this page."
        : result === "rejected"
          ? "Google did not approve Gmail access, or returned an invalid response. Return to Hyakki and select Restart Google sign-in. If Google blocked sign-in, check the Google app’s audience and access settings."
          : "This Google sign-in link has expired, or was already used or replaced. Return to Hyakki and select Restart Google sign-in to try again.",
      { status: result === "accepted" ? 200 : 400, headers },
    );
  }).pipe(HttpMiddleware.withLoggerDisabled),
);
