import {
  DesktopCloudAuthFetchInputSchema,
  DesktopCloudAuthFetchResultSchema,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as DesktopCloudAuth from "../../app/DesktopCloudAuth.ts";
import * as DesktopCloudAuthTokenStore from "../../app/DesktopCloudAuthTokenStore.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export class DesktopCloudAuthFetchError extends Data.TaggedError("DesktopCloudAuthFetchError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {
  override get message() {
    return this.reason;
  }
}

const allowedClerkFrontendApiHosts = (hostname: string): boolean =>
  hostname.endsWith(".clerk.accounts.dev") || hostname.endsWith(".clerk.accounts.com");

function validateClerkFrontendApiUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || !allowedClerkFrontendApiHosts(url.hostname)) {
    throw new DesktopCloudAuthFetchError({
      reason: "Desktop cloud auth fetch is restricted to Clerk Frontend API HTTPS hosts.",
    });
  }
  return url;
}

export const createCloudAuthRequest = makeIpcMethod({
  channel: IpcChannels.CREATE_CLOUD_AUTH_REQUEST_CHANNEL,
  payload: Schema.Void,
  result: Schema.String,
  handler: Effect.fn("desktop.ipc.cloudAuth.createRequest")(function* () {
    const cloudAuth = yield* DesktopCloudAuth.DesktopCloudAuth;
    return yield* cloudAuth.createRequest;
  }),
});

export const getCloudAuthToken = makeIpcMethod({
  channel: IpcChannels.GET_CLOUD_AUTH_TOKEN_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.cloudAuth.getToken")(function* () {
    const tokenStore = yield* DesktopCloudAuthTokenStore.DesktopCloudAuthTokenStore;
    return Option.getOrNull(yield* tokenStore.get);
  }),
});

export const setCloudAuthToken = makeIpcMethod({
  channel: IpcChannels.SET_CLOUD_AUTH_TOKEN_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.cloudAuth.setToken")(function* (token) {
    const tokenStore = yield* DesktopCloudAuthTokenStore.DesktopCloudAuthTokenStore;
    return yield* tokenStore.set(token);
  }),
});

export const clearCloudAuthToken = makeIpcMethod({
  channel: IpcChannels.CLEAR_CLOUD_AUTH_TOKEN_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.cloudAuth.clearToken")(function* () {
    const tokenStore = yield* DesktopCloudAuthTokenStore.DesktopCloudAuthTokenStore;
    yield* tokenStore.clear;
  }),
});

export const fetchCloudAuth = makeIpcMethod({
  channel: IpcChannels.FETCH_CLOUD_AUTH_CHANNEL,
  payload: DesktopCloudAuthFetchInputSchema,
  result: DesktopCloudAuthFetchResultSchema,
  handler: Effect.fn("desktop.ipc.cloudAuth.fetch")(function* (input) {
    const url = yield* Effect.try({
      try: () => validateClerkFrontendApiUrl(input.url),
      catch: (cause) =>
        cause instanceof DesktopCloudAuthFetchError
          ? cause
          : new DesktopCloudAuthFetchError({
              reason: "Desktop cloud auth fetch received an invalid URL.",
              cause,
            }),
    });

    const request = HttpClientRequest.make((input.method ?? "GET") as "GET" | "POST")(url, {
      headers: input.headers,
    }).pipe(
      input.body === undefined ? (request) => request : HttpClientRequest.bodyText(input.body),
    );

    const response = yield* HttpClient.execute(request).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopCloudAuthFetchError({
            reason: "Desktop cloud auth fetch failed.",
            cause,
          }),
      ),
    );

    const body = yield* response.text.pipe(
      Effect.mapError(
        (cause) =>
          new DesktopCloudAuthFetchError({
            reason: "Desktop cloud auth fetch response could not be read.",
            cause,
          }),
      ),
    );

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: "",
      headers: response.headers,
      body,
    };
  }),
});
