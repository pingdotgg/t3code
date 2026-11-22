import * as Clock from "effect/Clock"
import * as Digest from "effect/crypto/Digest"
import * as Mac from "effect/crypto/Mac"
import * as Effect from "effect/Effect"
import * as Hex from "effect/encoding/Hex"
import type * as HttpBody from "effect/http/HttpBody"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as Url from "effect/http/Url"
import * as Result from "effect/Result"

/**
 * The credentials a request is signed with.
 *
 * @internal
 */
export interface SigningCredentials {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken: string | undefined
}

const encoder = new TextEncoder()

/** Percent-encodes a string per RFC 3986, as SigV4 requires. */
const encodeRfc3986 = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

const service = "bedrock"

/** `YYYYMMDD'T'HHMMSS'Z'`, the SigV4 timestamp format. */
const formatAmzDate = (date: Date): string => date.toISOString().replace(/[-:]|\.\d{3}/g, "")

/**
 * The bytes of the request body, for the payload hash.
 */
const bodyBytes = (body: HttpBody.HttpBody): Effect.Effect<Uint8Array> => {
  switch (body._tag) {
    case "Empty": {
      return Effect.succeed(new Uint8Array(0))
    }
    case "Uint8Array": {
      return Effect.succeed(body.body)
    }
    case "Raw": {
      if (typeof body.body === "string") {
        return Effect.succeed(encoder.encode(body.body))
      }
      if (body.body instanceof Uint8Array) {
        return Effect.succeed(body.body)
      }
      if (body.body instanceof ArrayBuffer) {
        return Effect.succeed(new Uint8Array(body.body))
      }
      break
    }
  }
  return Effect.die(new Error(`AmazonBedrockClient cannot sign a request with a body of type '${body._tag}'`))
}

/**
 * Signs `request` with AWS Signature Version 4 for the Bedrock Runtime
 * service, adding the `authorization`, `x-amz-date` and, with a session
 * token, `x-amz-security-token` headers.
 *
 * **Details**
 *
 * The signed headers are `host`, `x-amz-date`, `content-type` when present
 * and `x-amz-security-token` when present. The canonical URI and query come
 * from the URL the transport sends, `url` with `urlParams` appended. Path
 * segments are encoded a second time in the canonical URI, as the service does
 * for every API but S3. The timestamp comes from the Effect `Clock`, and
 * SHA-256 and HMAC run on the given `Digest` and `Mac` services.
 *
 * @internal
 */
export const sign = (
  request: HttpClientRequest.HttpClientRequest,
  options: {
    readonly region: string
    readonly credentials: SigningCredentials
    readonly digest: Digest.Digest["Service"]
    readonly mac: Mac.Mac["Service"]
  }
): Effect.Effect<HttpClientRequest.HttpClientRequest> =>
  Effect.gen(function*() {
    const { digest, mac } = options
    // Signing keys are never empty, so a `CryptoError` means the `Mac`
    // service has no HMAC-SHA-256, which is a defect.
    const hmac = (key: Uint8Array, data: string): Effect.Effect<Uint8Array> =>
      Mac.key(Mac.hmacSha256, key).pipe(
        Effect.flatMap((key) => mac.sign(key, encoder.encode(data))),
        Effect.orDie
      )
    const { accessKeyId, secretAccessKey, sessionToken } = options.credentials
    const amzDate = formatAmzDate(new Date(yield* Clock.currentTimeMillis))
    const date = amzDate.slice(0, 8)
    const urlResult = Url.make(request.url, request.urlParams, undefined)
    if (Result.isFailure(urlResult)) {
      // The transport fails the request with an `InvalidUrlError` before sending it.
      return request
    }
    const url = urlResult.success

    // The headers this signer adds, which are also signed.
    const amzHeaders: Record<string, string> = {
      "x-amz-date": amzDate,
      ...(sessionToken !== undefined ? { "x-amz-security-token": sessionToken } : {})
    }
    const headers: Record<string, string> = { host: url.host, ...amzHeaders }
    const contentType = request.headers["content-type"]
    if (contentType !== undefined) {
      headers["content-type"] = contentType.trim().replace(/\s+/g, " ")
    }
    const signedHeaderNames = Object.keys(headers).sort()
    const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join("")
    const signedHeaders = signedHeaderNames.join(";")

    const canonicalUri = url.pathname.split("/").map(encodeRfc3986).join("/")
    const canonicalQuery = Array.from(url.searchParams.entries())
      .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
      .sort(([a, av], [b, bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0)
      .map(([key, value]) => `${key}=${value}`)
      .join("&")
    const payloadHash = yield* digest.digestHex(Digest.sha256, yield* bodyBytes(request.body))

    const canonicalRequest = [
      request.method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join("\n")

    const scope = `${date}/${options.region}/${service}/aws4_request`
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      yield* digest.digestHex(Digest.sha256, encoder.encode(canonicalRequest))
    ].join("\n")

    const kDate = yield* hmac(encoder.encode(`AWS4${secretAccessKey}`), date)
    const kRegion = yield* hmac(kDate, options.region)
    const kService = yield* hmac(kRegion, service)
    const kSigning = yield* hmac(kService, "aws4_request")
    const signature = Hex.encode(yield* hmac(kSigning, stringToSign))

    return HttpClientRequest.setHeaders(request, {
      authorization:
        `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      ...amzHeaders
    })
  })
