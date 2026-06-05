import {
  DesktopCloudAuthFetchInputSchema,
  DesktopCloudAuthFetchResultSchema,
} from "@t3tools/contracts";
import {
  clerkFrontendApiHostnameFromPublishableKey,
  isAllowedClerkFrontendApiHostname,
} from "@t3tools/shared/relayAuth";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as DesktopCloudAuth from "../../app/DesktopCloudAuth.ts";
import * as DesktopCloudAuthTokenStore from "../../app/DesktopCloudAuthTokenStore.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

declare const __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: string | undefined;

export class DesktopCloudAuthFetchError extends Data.TaggedError("DesktopCloudAuthFetchError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {
  override get message() {
    return this.reason;
  }
}

function configuredClerkFrontendApiHostname(): string | null {
  const publishableKey =
    process.env.T3CODE_CLERK_PUBLISHABLE_KEY?.trim() ||
    (typeof __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__ === "undefined"
      ? ""
      : __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__.trim());
  if (!publishableKey) return null;

  return clerkFrontendApiHostnameFromPublishableKey(publishableKey);
}

const allowedClerkFrontendApiHosts = (hostname: string): boolean =>
  isAllowedClerkFrontendApiHostname(hostname, configuredClerkFrontendApiHostname());

export function validateClerkFrontendApiUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || !allowedClerkFrontendApiHosts(url.hostname)) {
    throw new DesktopCloudAuthFetchError({
      reason: "Desktop cloud auth fetch is restricted to Clerk Frontend API HTTPS hosts.",
    });
  }
  return url;
}

function executeCloudAuthFetch(url: URL, input: typeof DesktopCloudAuthFetchInputSchema.Type) {
  return Effect.gen(function* () {
    const method = (input.method ?? "GET") as "GET" | "POST";
    const headers = new Headers(input.headers);
    const response = yield* HttpClientRequest.make(method)(url).pipe(
      HttpClientRequest.setHeaders(headers),
      input.body === undefined
        ? identity
        : HttpClientRequest.bodyText(input.body, headers.get("content-type") ?? undefined),
      HttpClient.execute,
      Effect.mapError(
        (cause) =>
          new DesktopCloudAuthFetchError({
            reason: "Desktop cloud auth fetch failed to execute.",
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
  });
}

const electronNetFetchLayer = Layer.unwrap(
  Effect.gen(function* () {
    const electronFetch = yield* Effect.promise(async () => {
      const electron = (await import("electron")) as {
        readonly net?: { readonly fetch?: typeof globalThis.fetch };
      };
      return typeof electron.net?.fetch === "function"
        ? electron.net.fetch.bind(electron.net)
        : null;
    }).pipe(Effect.catchCause(() => Effect.succeed(null)));

    if (!electronFetch) {
      yield* Effect.logWarning(
        "electron.net.fetch is not available, falling back to global fetch. This may cause unexpected errors.",
      );
    }

    return FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, electronFetch ?? globalThis.fetch)),
    );
  }),
);

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

    return yield* executeCloudAuthFetch(url, input).pipe(Effect.provide(electronNetFetchLayer));
  }),
});
