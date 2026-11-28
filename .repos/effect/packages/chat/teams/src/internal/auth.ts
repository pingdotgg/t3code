import * as Clock from "effect/Clock"
import type * as Signature from "effect/crypto/Signature"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Jwks from "effect/jose/Jwks"
import * as Jwt from "effect/jose/Jwt"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import type { Cloud } from "../TeamsChat.ts"
import { noRedirects, send } from "./connector.ts"
import { parseUrl } from "./parse.ts"

/** The longest `Authorization` header read. Anything longer is refused unread. */
const maxAuthorizationLength = 16 * 1024

/** How long after a failed metadata or key set fetch the next is tried. */
const retryAfter = 30_000

/** The longest OpenID metadata document read. */
const maxMetadataBytes = 64 * 1024

const Claims = Schema.Struct({
  serviceurl: Schema.optionalKey(Schema.String),
  serviceUrl: Schema.optionalKey(Schema.String)
})

/**
 * Keeps a key only when its `endorsements` is an array of strings holding
 * `msteams`. A key without them is dropped: fails closed.
 *
 * @internal
 */
export const endorsedForTeams = (jwk: { readonly [key: string]: unknown }): boolean => {
  const endorsements = jwk.endorsements
  return Array.isArray(endorsements) && endorsements.every((e) => typeof e === "string") &&
    endorsements.includes("msteams")
}

/** The body, or `undefined` once it passes `maxBytes` or can't be read. Never reads past the limit. */
const readBounded = (
  response: HttpClientResponse.HttpClientResponse,
  maxBytes: number
): Effect.Effect<Uint8Array | undefined> => {
  const declared = Number(response.headers["content-length"])
  if (Number.isFinite(declared) && declared > maxBytes) return Effect.succeed(undefined)
  const body = new Uint8Array(maxBytes)
  return Stream.runFoldEffect(response.stream, () => 0, (length, chunk) =>
    chunk.length > maxBytes - length
      ? Effect.fail("too_large" as const)
      : Effect.sync(() => {
        body.set(chunk, length)
        return length + chunk.length
      })).pipe(
      Effect.map((length) => body.subarray(0, length)),
      Effect.orElseSucceed(() => undefined)
    )
}

/** @internal */
export type Verdict = "ok" | "forbidden" | "unavailable"

/** What the token is checked against, from the activity's body. @internal */
export interface Activity {
  readonly serviceUrl: unknown
  readonly channelId: unknown
  readonly tenantId: string | undefined
}

/** The tenant of an activity: `conversation.tenantId`, else `channelData.tenant.id`. @internal */
export const tenantOf = (activity: Record<string, unknown>): string | undefined => {
  const conversation = activity.conversation
  if (Predicate.isObject(conversation) && typeof conversation.tenantId === "string") return conversation.tenantId
  const channelData = activity.channelData
  if (
    Predicate.isObject(channelData) && Predicate.isObject(channelData.tenant) &&
    typeof channelData.tenant.id === "string"
  ) {
    return channelData.tenant.id
  }
  return undefined
}

/**
 * Checks a Bot Framework bearer token: RS256 with a key endorsed for
 * `msteams` from the cloud's key set, the cloud's issuer, the app id as
 * audience, five minutes of skew and a required `exp`. Then the
 * `serviceurl` claim must equal the activity's `serviceUrl`, its
 * `channelId` must be `msteams` and its tenant the configured one.
 *
 * The key set is found lazily from the cloud's OpenID metadata, whose
 * `jwks_uri` must be `https:` on the metadata's own host. Neither fetch
 * follows a redirect: the key set's client has Fetch's redirects off for
 * each request, refreshes included. The metadata is read to at most 64 KiB.
 * Metadata that can't be fetched, read or parsed is `unavailable`. A key set that can't be read is `unavailable`, so
 * the webhook answers 503 and Teams retries; every other failure is
 * `forbidden`.
 *
 * @internal
 */
export const makeVerifier = Effect.fnUntraced(function*(options: {
  readonly cloud: Cloud
  readonly appId: string
  readonly tenantId: string
}) {
  const http = yield* HttpClient.HttpClient
  const scope = yield* Effect.scope
  const signature = yield* Effect.context<Signature.Signature>()
  const lock = Semaphore.makeUnsafe(1)
  let keys: Jwks.Jwks["Service"] | undefined
  let failedAt = Number.NEGATIVE_INFINITY

  const jwksUri = Effect.gen(function*() {
    const metadataUrl = parseUrl(options.cloud.openIdMetadataUrl)
    if (metadataUrl === undefined) return yield* Effect.fail("metadata_url" as const)
    const response = yield* send(http, HttpClientRequest.get(metadataUrl.href), false, "openIdMetadata")
    if (response.status !== 200) return yield* Effect.fail("metadata_status" as const)
    const body = yield* readBounded(response, maxMetadataBytes)
    if (body === undefined || body.length === 0) return yield* Effect.fail("metadata_size" as const)
    let json: unknown
    try {
      json = JSON.parse(new TextDecoder().decode(body))
    } catch {
      return yield* Effect.fail("metadata_json" as const)
    }
    const uri = Predicate.isObject(json) ? json.jwks_uri : undefined
    const parsed = typeof uri === "string" ? parseUrl(uri) : undefined
    if (parsed === undefined) return yield* Effect.fail("metadata_jwks_uri" as const)
    if (parsed.protocol !== "https:" || parsed.port !== "" || parsed.hostname !== metadataUrl.hostname) {
      return yield* Effect.fail("metadata_jwks_host" as const)
    }
    return parsed.href
  }).pipe(Effect.scoped)

  // The key set, found once. A failure is not retried for `retryAfter`, so
  // unauthenticated requests can't drive a metadata fetch each.
  const keySet: Effect.Effect<Jwks.Jwks["Service"] | undefined> = lock.withPermit(Effect.gen(function*() {
    if (keys !== undefined) return keys
    const now = yield* Clock.currentTimeMillis
    if (now - failedAt < retryAfter) return undefined
    const made = yield* jwksUri.pipe(
      Effect.flatMap((url) => Jwks.makeRemote({ url, filter: endorsedForTeams })),
      Effect.provideService(Scope.Scope, scope),
      Effect.provideService(HttpClient.HttpClient, noRedirects(http)),
      Effect.option
    )
    if (made._tag === "None") {
      failedAt = now
      return undefined
    }
    keys = made.value
    return keys
  }))

  return (authorization: string | undefined, activity: Activity): Effect.Effect<Verdict> =>
    Effect.gen(function*() {
      if (authorization === undefined || authorization.length > maxAuthorizationLength) return "forbidden"
      const match = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(authorization)
      if (match === null) return "forbidden"
      const resolved = yield* keySet
      if (resolved === undefined) return "unavailable"
      const exit = yield* Jwt.verifyWithKeySet(Claims, match[1], {
        algorithms: ["RS256"],
        issuer: options.cloud.issuer,
        audience: options.appId,
        clockTolerance: "5 minutes",
        requiredClaims: ["exp"]
      }).pipe(
        Effect.provideService(Jwks.Jwks, resolved),
        Effect.provideContext(signature),
        Effect.exit
      )
      if (Exit.isFailure(exit)) {
        const unavailable = exit.cause.reasons.some((reason) =>
          reason._tag === "Fail" && reason.error._tag === "JoseError" &&
          reason.error.reason._tag === "KeySetUnavailable"
        )
        return unavailable ? "unavailable" : "forbidden"
      }
      const claims = exit.value.claims
      const claimed = claims.serviceurl ?? claims.serviceUrl
      if (typeof activity.serviceUrl !== "string" || claimed !== activity.serviceUrl) return "forbidden"
      if (activity.channelId !== "msteams") return "forbidden"
      if (activity.tenantId !== options.tenantId) return "forbidden"
      return "ok"
    })
})
