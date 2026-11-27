import { retrySafe } from "effect/chat/ChatAdapter"
import type { ChatError, ChatErrorReason } from "effect/chat/ChatError"
import * as Clock from "effect/Clock"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import type * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import type { Cloud, Credentials } from "../TeamsChat.ts"
import * as Errors from "./errors.ts"
import { parseUrl } from "./parse.ts"

/** A cloud is privileged configuration: nothing in it is ever read from an activity. @internal */
export const publicCloud: Cloud = {
  connectorUrl: "https://smba.trafficmanager.net/teams",
  connectorHosts: ["smba.trafficmanager.net"],
  openIdMetadataUrl: "https://login.botframework.com/v1/.well-known/openidconfiguration",
  issuer: "https://api.botframework.com",
  loginUrl: "https://login.microsoftonline.com",
  connectorScope: "https://api.botframework.com/.default",
  fileHostSuffixes: ["sharepoint.com"],
  redirectHosts: []
}

/** How long before `expiresAt` a cached token is dropped. */
const refreshMargin = Duration.minutes(5)

/**
 * The trust step for a Connector base URL: `https:`, the default port, no
 * userinfo and an exact host in the allowlist. Gives the URL without a
 * trailing slash, or `undefined`.
 *
 * @internal
 */
export const trustedServiceUrl = (url: string, hosts: ReadonlyArray<string>): string | undefined => {
  const parsed = parseUrl(url)
  if (
    parsed === undefined || parsed.protocol !== "https:" || parsed.port !== "" || parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" || parsed.hash !== "" || !hosts.includes(parsed.hostname)
  ) {
    return undefined
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, "")
}

/**
 * Gets a token by client credentials, or from the consumer's provider, and
 * caches it until five minutes before it expires. A token with no expiry is
 * not cached.
 *
 * @internal
 */
export const makeTokens = (options: {
  readonly http: HttpClient.HttpClient
  readonly cloud: Cloud
  readonly appId: string
  readonly tenantId: string
  readonly credentials: Credentials
}) => {
  const cache = new Map<string, { readonly token: Redacted.Redacted<string>; readonly until: number }>()
  const lock = Semaphore.makeUnsafe(1)
  const fail = (reason: ChatErrorReason) => Effect.fail(Errors.chatError("token", reason))

  const clientCredentials = (secret: Redacted.Redacted<string>) => (scope: string) =>
    Effect.gen(function*() {
      const url = `${options.cloud.loginUrl}/${encodeURIComponent(options.tenantId)}/oauth2/v2.0/token`
      const request = HttpClientRequest.post(url).pipe(
        HttpClientRequest.bodyUrlParams({
          grant_type: "client_credentials",
          client_id: options.appId,
          client_secret: Redacted.value(secret),
          scope
        })
      )
      const response = yield* send(options.http, request, false, "token")
      if (response.status !== 200) {
        return yield* fail(Errors.reasonForStatus(response.status, { write: false }))
      }
      const json = yield* response.json.pipe(
        Effect.catch((cause) => fail(Errors.invalidResponse(false, "invalid_json", cause)))
      )
      if (!Predicate.isObject(json) || typeof json.access_token !== "string" || json.access_token === "") {
        return yield* fail(Errors.invalidResponse(false, "missing_access_token"))
      }
      const now = yield* Clock.currentTimeMillis
      const expiresIn = typeof json.expires_in === "number" ? json.expires_in : Number(json.expires_in)
      return {
        token: Redacted.make(json.access_token),
        ...(Number.isFinite(expiresIn) && expiresIn > 0
          ? { expiresAt: DateTime.makeUnsafe(now + expiresIn * 1000) }
          : {})
      }
    })

  const provider = Redacted.isRedacted(options.credentials)
    ? clientCredentials(options.credentials)
    : options.credentials

  return (scope: string): Effect.Effect<Redacted.Redacted<string>, ChatError> =>
    lock.withPermit(Effect.gen(function*() {
      const now = yield* Clock.currentTimeMillis
      const cached = cache.get(scope)
      if (cached !== undefined && cached.until > now) return cached.token
      cache.delete(scope)
      const token = yield* retrySafe(provider(scope))
      if (token.expiresAt !== undefined) {
        const until = DateTime.toEpochMillis(token.expiresAt) - Duration.toMillis(refreshMargin)
        if (until > now) cache.set(scope, { token: token.token, until })
      }
      return token.token
    }))
}

/**
 * The client with Fetch's redirects off, for every request it sends,
 * including those made by code the adapter hands it to, such as the key set.
 *
 * @internal
 */
export const noRedirects = (http: HttpClient.HttpClient): HttpClient.HttpClient =>
  HttpClient.transform(
    http,
    (effect) => Effect.provideService(effect, FetchHttpClient.RequestInit, { redirect: "manual" })
  )

/**
 * The URL a request goes to, with its query parameters and without a hash.
 *
 * @internal
 */
export const effectiveUrl = (request: HttpClientRequest.HttpClientRequest): string | undefined => {
  const url = Option.getOrUndefined(HttpClientRequest.toUrl(request))
  if (url === undefined) return undefined
  url.hash = ""
  return url.href
}

/**
 * Sends one request with redirects off. A response from another URL than
 * the request's, query included, means something followed a redirect, and
 * is refused.
 *
 * @internal
 */
export const send = (
  http: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
  write: boolean,
  op: string
): Effect.Effect<HttpClientResponse.HttpClientResponse, ChatError> =>
  noRedirects(http).execute(request).pipe(
    Effect.catch((error) => Effect.fail(Errors.chatError(op, Errors.transport(write, error.reason._tag, error)))),
    Effect.flatMap((response) =>
      response.url !== effectiveUrl(request)
        ? Effect.fail(Errors.chatError(op, Errors.untrustedUrl()))
        : Effect.succeed(response)
    )
  )

/** @internal */
export interface CallOptions {
  readonly write?: boolean | undefined
  readonly retry?: boolean | undefined
  /**
   * The activity's own `serviceUrl`, for an op tied to an inbound activity.
   * It is checked against the allowlist before a token is attached. Absent,
   * the cloud's global Connector URL is used.
   */
  readonly serviceUrl?: string | undefined
  readonly query?: Readonly<Record<string, string>> | undefined
  /** The op for the error. Default: the method and path. */
  readonly op?: string | undefined
}

/** @internal */
export interface Connector {
  readonly call: (
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body: unknown,
    options?: CallOptions | undefined
  ) => Effect.Effect<Schema.Json | undefined, ChatError>
}

/**
 * The Connector client. `path` starts with `/v3/` and has its segments
 * encoded by the caller.
 *
 * @internal
 */
export const make = (options: {
  readonly http: HttpClient.HttpClient
  readonly cloud: Cloud
  readonly token: (scope: string) => Effect.Effect<Redacted.Redacted<string>, ChatError>
}): Connector => {
  const once = (
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body: unknown,
    callOptions: CallOptions | undefined
  ): Effect.Effect<Schema.Json | undefined, ChatError> => {
    const write = callOptions?.write === true
    const op = callOptions?.op ?? `${method} ${path.split("/").slice(0, 3).join("/")}`
    const fail = (reason: ChatErrorReason) => Effect.fail(Errors.chatError(op, reason))
    return Effect.gen(function*() {
      const base = callOptions?.serviceUrl === undefined
        ? options.cloud.connectorUrl
        : trustedServiceUrl(callOptions.serviceUrl, options.cloud.connectorHosts)
      if (base === undefined) return yield* fail(Errors.untrustedUrl())
      const token = yield* Effect.mapError(options.token(options.cloud.connectorScope), Errors.withOp(op))
      let request = HttpClientRequest.make(method)(base + path).pipe(
        HttpClientRequest.bearerToken(Redacted.value(token)),
        HttpClientRequest.setHeader("accept", "application/json")
      )
      if (callOptions?.query !== undefined) request = HttpClientRequest.setUrlParams(request, callOptions.query)
      if (body !== undefined) request = HttpClientRequest.bodyJsonUnsafe(request, body)
      const response = yield* send(options.http, request, write, op)
      const retryAfter = Errors.parseRetryAfter(response.headers["retry-after"])
      if (response.status < 200 || response.status >= 300) {
        const json = yield* Effect.orElseSucceed(response.json, () => undefined)
        const error = Predicate.isObject(json) && Predicate.isObject(json.error) ? json.error : undefined
        const code = typeof error?.code === "string" ? error.code : undefined
        return yield* fail(Errors.reasonForStatus(response.status, { write, retryAfter, code }))
      }
      const text = yield* response.text.pipe(
        Effect.catch((cause) => fail(Errors.invalidResponse(write, "invalid_body", cause)))
      )
      if (text.trim() === "") return undefined
      try {
        return JSON.parse(text) as Schema.Json
      } catch (cause) {
        return yield* fail(Errors.invalidResponse(write, "invalid_json", cause))
      }
    }).pipe(Effect.scoped)
  }
  return {
    call: (method, path, body, callOptions) => {
      const call = once(method, path, body, callOptions)
      return callOptions?.retry === false ? call : retrySafe(call)
    }
  }
}

/** Encodes one path segment. @internal */
export const segment = (value: string): string => encodeURIComponent(value)
