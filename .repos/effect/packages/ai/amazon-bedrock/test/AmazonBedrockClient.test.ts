import { AmazonBedrockClient } from "@effect/ai-amazon-bedrock"
import { assert, describe, it } from "@effect/vitest"
import { assertDefined } from "@effect/vitest/utils"
import { ConfigProvider, Effect, Layer, Redacted, Stream, Tracer } from "effect"
import { AiError } from "effect/ai"
import { Digest, Mac, SecureRandom } from "effect/crypto"
import { HttpClient, type HttpClientError, type HttpClientRequest, HttpClientResponse, UrlParams } from "effect/http"
import * as NodeCrypto from "node:crypto"
import { concat, encodeFrame, encodeRawFrame, eventFrame, exceptionFrame, textReplyFrames } from "./utils.ts"

const modelId = "anthropic.claude-3-haiku-20240307-v1:0"
const encodedModelId = "anthropic.claude-3-haiku-20240307-v1%3A0"
const accessKeyId = "AKIAIOSFODNN7EXAMPLE"
const secretAccessKey = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"

const payload = {
  modelId,
  messages: [{ role: "user" as const, content: [{ text: "Hello" }] }]
}

const converseBody = {
  output: { message: { role: "assistant", content: [{ text: "Hi" }] } },
  stopReason: "end_turn",
  usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
  metrics: { latencyMs: 42 }
}

const staticKeys = AmazonBedrockClient.layer({
  region: "us-east-1",
  accessKeyId,
  secretAccessKey: Redacted.make(secretAccessKey)
})

const converse = Effect.flatMap(AmazonBedrockClient.AmazonBedrockClient, (client) => client.converse(payload))

const converseStream = Stream.unwrap(
  Effect.map(AmazonBedrockClient.AmazonBedrockClient, (client) => client.converseStream(payload))
)

describe("AmazonBedrockClient", () => {
  describe("authentication", () => {
    it.effect("signs requests with SigV4 from static keys using the Effect clock", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) => Effect.succeed(jsonResponse(request, 200, converseBody)))

        const response = yield* converse.pipe(Effect.provide(staticKeys), Effect.provide(http.layer))

        assert.strictEqual(response.stopReason, "end_turn")
        const request = http.requests[0]
        assertDefined(request)
        assert.strictEqual(request.method, "POST")
        assert.strictEqual(
          request.url,
          `https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodedModelId}/converse`
        )
        // The TestClock starts at the Unix epoch.
        assert.strictEqual(request.headers["x-amz-date"], "19700101T000000Z")
        const signature = verifySigV4(request, secretAccessKey)
        assert.strictEqual(signature.accessKeyId, accessKeyId)
        assert.strictEqual(signature.date, "19700101")
        assert.strictEqual(signature.region, "us-east-1")
        assert.strictEqual(signature.service, "bedrock")
        assert.include(signature.signedHeaders, "host")
        assert.include(signature.signedHeaders, "x-amz-date")
        assert.strictEqual(signature.actual, signature.expected)
      }))

    it.effect("signs the session token when one is configured", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) => Effect.succeed(jsonResponse(request, 200, converseBody)))
        const layer = AmazonBedrockClient.layer({
          region: "us-east-1",
          accessKeyId,
          secretAccessKey: Redacted.make(secretAccessKey),
          sessionToken: Redacted.make("session-token")
        })

        yield* converse.pipe(Effect.provide(layer), Effect.provide(http.layer))

        const request = http.requests[0]
        assertDefined(request)
        assert.strictEqual(request.headers["x-amz-security-token"], "session-token")
        const signature = verifySigV4(request, secretAccessKey)
        assert.include(signature.signedHeaders, "x-amz-security-token")
        assert.strictEqual(signature.actual, signature.expected)
      }))

    it.effect("signs with the Digest and Mac services the caller provides", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) => Effect.succeed(jsonResponse(request, 200, converseBody)))
        const calls = { digest: 0, hmac: 0 }
        const nodeCrypto = Layer.merge(
          Layer.mock(Digest.Digest, {
            digestHex: (_, data) =>
              Effect.sync(() => {
                calls.digest += 1
                return sha256Hex(data)
              })
          }),
          Mac.layerWebCryptoWith({
            hmac: (_, key, data) => {
              calls.hmac += 1
              return NodeCrypto.createHmac("sha256", key).update(data).digest()
            }
          }).pipe(Layer.provide(SecureRandom.layerWebCrypto))
        )

        yield* converse.pipe(
          Effect.provide(staticKeys),
          Effect.provide(nodeCrypto),
          Effect.provide(http.transport)
        )

        const request = http.requests[0]
        assertDefined(request)
        const signature = verifySigV4(request, secretAccessKey)
        assert.strictEqual(signature.actual, signature.expected)
        assert.isAbove(calls.digest, 0)
        assert.isAbove(calls.hmac, 0)
      }))

    it.effect("authenticates with an API key without calling Digest or Mac", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) => Effect.succeed(jsonResponse(request, 200, converseBody)))
        // Every method of a mocked service dies when it is called.
        const unusedCrypto = Layer.merge(Layer.mock(Digest.Digest, {}), Layer.mock(Mac.Mac, {}))

        yield* converse.pipe(
          Effect.provide(AmazonBedrockClient.layer({ apiKey: Redacted.make("bedrock-api-key") })),
          Effect.provide(unusedCrypto),
          Effect.provide(http.transport)
        )

        const request = http.requests[0]
        assertDefined(request)
        assert.strictEqual(request.headers["authorization"], "Bearer bedrock-api-key")
      }))

    it.effect("sends a Bedrock API key as a bearer token and honours apiUrl", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) => Effect.succeed(jsonResponse(request, 200, converseBody)))
        const layer = AmazonBedrockClient.layer({
          apiKey: Redacted.make("bedrock-api-key"),
          apiUrl: "https://bedrock.example.test"
        })

        yield* converse.pipe(Effect.provide(layer), Effect.provide(http.layer))

        const request = http.requests[0]
        assertDefined(request)
        assert.strictEqual(request.url, `https://bedrock.example.test/model/${encodedModelId}/converse`)
        assert.strictEqual(request.headers["authorization"], "Bearer bedrock-api-key")
        assert.notProperty(request.headers, "x-amz-date")
      }))

    it.effect("authenticates direct requests through the exposed client", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) => Effect.succeed(jsonResponse(request, 200, { ok: true })))

        yield* Effect.flatMap(
          AmazonBedrockClient.AmazonBedrockClient,
          (service) => service.client.post(`/model/${encodedModelId}/invoke`)
        ).pipe(Effect.provide(staticKeys), Effect.provide(http.layer))

        const request = http.requests[0]
        assertDefined(request)
        assert.strictEqual(
          request.url,
          `https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodedModelId}/invoke`
        )
        const signature = verifySigV4(request, secretAccessKey)
        assert.strictEqual(signature.accessKeyId, accessKeyId)
        assert.strictEqual(signature.actual, signature.expected)
      }))

    it.effect("signs the query of a direct request built from urlParams", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) => Effect.succeed(jsonResponse(request, 200, { ok: true })))

        yield* Effect.flatMap(
          AmazonBedrockClient.AmazonBedrockClient,
          (service) => service.client.get("/async-invoke", { urlParams: { maxResults: 1 } })
        ).pipe(Effect.provide(staticKeys), Effect.provide(http.layer))

        const request = http.requests[0]
        assertDefined(request)
        assert.strictEqual(UrlParams.toString(request.urlParams), "maxResults=1")
        const signature = verifySigV4(request, secretAccessKey)
        assert.strictEqual(signature.actual, signature.expected)
      }))

    it.effect("redacts the session token in the header tracing of a direct request", () =>
      Effect.gen(function*() {
        const spans: Array<Tracer.NativeSpan> = []
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options)
            spans.push(span)
            return span
          }
        })
        // `HttpClient.make` adds the client span that records the headers.
        const client = HttpClient.make((request) => Effect.succeed(jsonResponse(request, 200, { ok: true })))
        const layer = AmazonBedrockClient.layer({
          region: "us-east-1",
          accessKeyId,
          secretAccessKey: Redacted.make(secretAccessKey),
          sessionToken: Redacted.make("session-token")
        }).pipe(Layer.provide([Layer.succeed(HttpClient.HttpClient, client), webCrypto]))

        yield* Effect.flatMap(
          AmazonBedrockClient.AmazonBedrockClient,
          (service) => service.client.get("/async-invoke")
        ).pipe(
          Effect.provide(layer),
          Effect.provideService(HttpClient.TracerHeaderFilter, () => true),
          Effect.withTracer(tracer)
        )

        const span = spans.find((span) => span.attributes.get("http.request.method") === "GET")
        assertDefined(span)
        assert.strictEqual(span.attributes.get("http.request.header.x-amz-security-token"), "<redacted>")
      }))

    it.effect("resolves the credentials effect on every request", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) => Effect.succeed(jsonResponse(request, 200, converseBody)))
        let calls = 0
        const layer = AmazonBedrockClient.layer({
          region: "us-east-1",
          credentials: Effect.sync(() => {
            calls += 1
            return { accessKeyId: `AKIA${calls}`, secretAccessKey, sessionToken: `token-${calls}` }
          })
        })

        yield* converse.pipe(Effect.provide(layer), Effect.provide(http.layer))
        yield* converse.pipe(Effect.provide(layer), Effect.provide(http.layer))

        assert.deepStrictEqual(http.requests.map((request) => verifySigV4(request, secretAccessKey).accessKeyId), [
          "AKIA1",
          "AKIA2"
        ])
        assert.deepStrictEqual(http.requests.map((request) => request.headers["x-amz-security-token"]), [
          "token-1",
          "token-2"
        ])
      }))

    it.effect("fails with the error of the credentials effect", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) => Effect.succeed(jsonResponse(request, 200, converseBody)))
        const layer = AmazonBedrockClient.layer({
          region: "us-east-1",
          credentials: Effect.fail(
            new AiError.AiError({
              module: "Vault",
              method: "credentials",
              reason: new AiError.AuthenticationError({ kind: "Unknown", description: "vault is down" })
            })
          )
        })

        const error = yield* converse.pipe(Effect.provide(layer), Effect.provide(http.layer), Effect.flip)

        assert.strictEqual(error.reason._tag, "AuthenticationError")
        if (error.reason._tag !== "AuthenticationError") return
        assert.strictEqual(error.reason.kind, "Unknown")
        assert.strictEqual(error.reason.description, "vault is down")
        assert.strictEqual(http.requests.length, 0)
      }))

    it.effect("fails with MissingKey when no credentials are configured", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) => Effect.succeed(jsonResponse(request, 200, converseBody)))

        const error = yield* converse.pipe(
          Effect.provide(AmazonBedrockClient.layer({ region: "us-east-1" })),
          Effect.provide(http.layer),
          Effect.flip
        )

        assert.strictEqual(error.reason._tag, "AuthenticationError")
        if (error.reason._tag !== "AuthenticationError") return
        assert.strictEqual(error.reason.kind, "MissingKey")
        assert.strictEqual(http.requests.length, 0)
      }))

    it.effect("omits request credentials from error context", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) =>
          Effect.succeed(jsonResponse(request, 400, { message: "Malformed input request" }, "ValidationException"))
        )
        const layer = AmazonBedrockClient.layer({
          region: "us-east-1",
          accessKeyId,
          secretAccessKey: Redacted.make(secretAccessKey),
          sessionToken: Redacted.make("session-token")
        })

        const error = yield* converse.pipe(Effect.provide(layer), Effect.provide(http.layer), Effect.flip)

        assert.strictEqual(error.reason._tag, "InvalidRequestError")
        if (error.reason._tag !== "InvalidRequestError") return
        assert.isDefined(error.reason.http)
        assert.strictEqual("request" in error.reason.http!, false)
        const serialized = JSON.stringify(error)
        assert.strictEqual(serialized.includes(accessKeyId), false)
        assert.strictEqual(serialized.includes(secretAccessKey), false)
        assert.strictEqual(serialized.includes("session-token"), false)
      }))
  })

  describe("layerConfig", () => {
    it.effect("reads the AWS keys and region from the environment", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) => Effect.succeed(jsonResponse(request, 200, converseBody)))

        yield* converse.pipe(
          Effect.provide(AmazonBedrockClient.layerConfig()),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({
            env: {
              AWS_REGION: "eu-west-1",
              AWS_ACCESS_KEY_ID: accessKeyId,
              AWS_SECRET_ACCESS_KEY: secretAccessKey,
              AWS_SESSION_TOKEN: "session-token"
            }
          }))),
          Effect.provide(http.layer)
        )

        const request = http.requests[0]
        assertDefined(request)
        assert.strictEqual(
          request.url,
          `https://bedrock-runtime.eu-west-1.amazonaws.com/model/${encodedModelId}/converse`
        )
        assert.strictEqual(request.headers["x-amz-security-token"], "session-token")
        const signature = verifySigV4(request, secretAccessKey)
        assert.strictEqual(signature.accessKeyId, accessKeyId)
        assert.strictEqual(signature.region, "eu-west-1")
        assert.strictEqual(signature.actual, signature.expected)
      }))

    it.effect("reads a Bedrock API key from the environment", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) => Effect.succeed(jsonResponse(request, 200, converseBody)))

        yield* converse.pipe(
          Effect.provide(AmazonBedrockClient.layerConfig()),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({
            env: { AWS_REGION: "eu-west-1", AWS_BEARER_TOKEN_BEDROCK: "bedrock-api-key" }
          }))),
          Effect.provide(http.layer)
        )

        const request = http.requests[0]
        assertDefined(request)
        assert.strictEqual(request.headers["authorization"], "Bearer bedrock-api-key")
      }))
  })

  describe("error mapping", () => {
    const cases: ReadonlyArray<{
      readonly status: number
      readonly errorType: string
      readonly reason: AiError.AiErrorReason["_tag"]
      readonly kind?: AiError.AuthenticationError["kind"]
    }> = [
      { status: 400, errorType: "ValidationException", reason: "InvalidRequestError" },
      { status: 404, errorType: "ResourceNotFoundException", reason: "InvalidRequestError" },
      { status: 400, errorType: "ServiceQuotaExceededException", reason: "QuotaExhaustedError" },
      {
        status: 403,
        errorType: "AccessDeniedException",
        reason: "AuthenticationError",
        kind: "InsufficientPermissions"
      },
      { status: 403, errorType: "ExpiredTokenException", reason: "AuthenticationError", kind: "ExpiredKey" },
      { status: 403, errorType: "UnrecognizedClientException", reason: "AuthenticationError", kind: "InvalidKey" },
      { status: 403, errorType: "InvalidSignatureException", reason: "AuthenticationError", kind: "InvalidKey" },
      { status: 429, errorType: "ThrottlingException", reason: "RateLimitError" },
      { status: 500, errorType: "InternalServerException", reason: "InternalProviderError" },
      { status: 503, errorType: "ServiceUnavailableException", reason: "InternalProviderError" }
    ]

    for (const testCase of cases) {
      it.effect(`maps ${testCase.status} ${testCase.errorType} to ${testCase.reason}`, () =>
        Effect.gen(function*() {
          const http = makeHttpClient((request) =>
            Effect.succeed(jsonResponse(request, testCase.status, { message: "provider message" }, testCase.errorType))
          )

          const error = yield* converse.pipe(Effect.provide(staticKeys), Effect.provide(http.layer), Effect.flip)

          assert.strictEqual(error._tag, "AiError")
          assert.strictEqual(error.reason._tag, testCase.reason)
          if (testCase.kind !== undefined && error.reason._tag === "AuthenticationError") {
            assert.strictEqual(error.reason.kind, testCase.kind)
          }
          if ("description" in error.reason) {
            assert.include(error.reason.description ?? "", "provider message")
          }
        }))
    }
  })

  describe("converse", () => {
    it.effect("preserves response fields and content blocks it does not model", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) =>
          Effect.succeed(jsonResponse(request, 200, {
            ...converseBody,
            output: {
              message: {
                role: "assistant",
                content: [{ text: "Hi" }, { citationsContent: { content: [{ text: "cited" }] } }]
              }
            },
            additionalModelResponseFields: { stop_sequence: null }
          }))
        )

        const response = yield* converse.pipe(Effect.provide(staticKeys), Effect.provide(http.layer))

        assert.deepStrictEqual(response.output.message.content[1] as unknown, {
          citationsContent: { content: [{ text: "cited" }] }
        })
        const raw: Record<string, unknown> = response
        assert.deepStrictEqual(raw.additionalModelResponseFields, { stop_sequence: null })
      }))
  })

  describe("converseStream", () => {
    it.effect("preserves fields of known events and nested structs it does not model", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) =>
          Effect.succeed(eventStreamResponse(request, [
            concat([
              eventFrame("messageStart", { role: "assistant" }),
              eventFrame("messageStop", {
                stopReason: "stop_sequence",
                additionalModelResponseFields: { stop_sequence: "END" }
              }),
              eventFrame("metadata", {
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheDetails: { tier: "default" } },
                metrics: { latencyMs: 1 }
              })
            ])
          ]))
        )

        const events = yield* converseStream.pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.provide(staticKeys),
          Effect.provide(http.layer)
        )

        assert.deepStrictEqual(events[1] as unknown, {
          messageStop: { stopReason: "stop_sequence", additionalModelResponseFields: { stop_sequence: "END" } }
        })
        const metadata = events[2]
        assertDefined(metadata)
        const usage: Record<string, unknown> = "metadata" in metadata ? metadata.metadata.usage : {}
        assert.deepStrictEqual(usage.cacheDetails, { tier: "default" })
      }))

    it.effect("preserves an event it does not model", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) =>
          Effect.succeed(eventStreamResponse(request, [
            concat([
              eventFrame("messageStart", { role: "assistant" }),
              eventFrame("someFutureEvent", { detail: 1 }),
              eventFrame("messageStop", { stopReason: "end_turn" })
            ])
          ]))
        )

        const events = yield* converseStream.pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.provide(staticKeys),
          Effect.provide(http.layer)
        )

        assert.deepStrictEqual(events.map((event) => Object.keys(event)[0]), [
          "messageStart",
          "someFutureEvent",
          "messageStop"
        ])
        assert.deepStrictEqual(events[1] as unknown, { someFutureEvent: { detail: 1 } })
      }))

    it.effect("decodes event frames split across chunks", () =>
      Effect.gen(function*() {
        const bytes = concat(textReplyFrames("Hello"))
        const http = makeHttpClient((request) =>
          Effect.succeed(
            eventStreamResponse(request, [bytes.subarray(0, 20), bytes.subarray(20, 95), bytes.subarray(95)])
          )
        )

        const events = yield* converseStream.pipe(
          Stream.runCollect,
          Effect.provide(staticKeys),
          Effect.provide(http.layer)
        )

        const request = http.requests[0]
        assertDefined(request)
        assert.strictEqual(
          request.url,
          `https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodedModelId}/converse-stream`
        )
        assert.deepStrictEqual(Array.from(events).map((event) => Object.keys(event)[0]), [
          "messageStart",
          "contentBlockDelta",
          "contentBlockStop",
          "messageStop",
          "metadata"
        ])
        const delta = Array.from(events)[1]
        assert.deepStrictEqual(
          "contentBlockDelta" in delta ? delta.contentBlockDelta.delta : undefined,
          { text: "Hello" }
        )
      }))

    it.effect("fails with the mapped error for an exception frame", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) =>
          Effect.succeed(eventStreamResponse(request, [
            concat([
              eventFrame("messageStart", { role: "assistant" }),
              exceptionFrame("throttlingException", { message: "Too many requests" })
            ])
          ]))
        )

        const error = yield* converseStream.pipe(
          Stream.runCollect,
          Effect.provide(staticKeys),
          Effect.provide(http.layer),
          Effect.flip
        )

        assert.strictEqual(error.reason._tag, "RateLimitError")
      }))

    const malformed: ReadonlyArray<{ readonly label: string; readonly bytes: Uint8Array }> = [
      {
        label: "a frame whose message CRC does not match",
        bytes: eventFrame("messageStart", { role: "assistant" }, { messageCrc: 0 })
      },
      {
        label: "a frame whose prelude CRC does not match",
        bytes: eventFrame("messageStart", { role: "assistant" }, { preludeCrc: 0 })
      },
      {
        label: "a frame shorter than the 16 byte minimum",
        bytes: eventFrame("messageStart", { role: "assistant" }, { totalLength: 0 })
      },
      {
        label: "a frame cut off before its declared length",
        bytes: eventFrame("messageStart", { role: "assistant" }).subarray(0, 24)
      },
      {
        label: "a CRC-valid frame whose headers block is cut off",
        bytes: encodeRawFrame(new Uint8Array([255]), new TextEncoder().encode("{}"))
      },
      {
        label: "a payload that is not JSON",
        bytes: encodeFrame(
          { ":message-type": "event", ":event-type": "messageStart", ":content-type": "application/json" },
          new TextEncoder().encode("{not json")
        )
      }
    ]

    for (const { bytes, label } of malformed) {
      it.effect(`rejects ${label} with InvalidResponseError`, () =>
        Effect.gen(function*() {
          const http = makeHttpClient((request) => Effect.succeed(eventStreamResponse(request, [bytes])))

          const error = yield* converseStream.pipe(
            Stream.runCollect,
            Effect.provide(staticKeys),
            Effect.provide(http.layer),
            Effect.flip
          )

          assert.strictEqual(error._tag, "AiError")
          assert.strictEqual(error.reason._tag, "InvalidResponseError")
        }))
    }
  })
})

// The client signs with the `Digest` and `Mac` its caller provides.
const webCrypto = Layer.merge(
  Digest.layerWebCrypto,
  Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto))
)

const makeHttpClient = (
  handler: (
    request: HttpClientRequest.HttpClientRequest
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>
) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  const client = HttpClient.makeWith(
    Effect.fnUntraced(function*(requestEffect) {
      const request = yield* requestEffect
      requests.push(request)
      return yield* handler(request)
    }),
    Effect.succeed as HttpClient.HttpClient.Preprocess<HttpClientError.HttpClientError, never>
  )
  const transport = Layer.succeed(HttpClient.HttpClient, client)
  return { requests, transport, layer: Layer.merge(transport, webCrypto) }
}

const jsonResponse = (
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  body: unknown,
  errorType?: string
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        ...(errorType === undefined
          ? {}
          : { "x-amzn-errortype": `${errorType}:http://internal.amazon.com/coral/com.amazon.bedrock/` })
      }
    })
  )

const eventStreamResponse = (
  request: HttpClientRequest.HttpClientRequest,
  chunks: ReadonlyArray<Uint8Array>
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk)
          controller.close()
        }
      }),
      { status: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } }
    )
  )

const encodeRfc3986 = (segment: string): string =>
  encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

const sha256Hex = (data: string | Uint8Array): string => NodeCrypto.createHash("sha256").update(data).digest("hex")

const hmac = (key: string | Uint8Array, data: string): Uint8Array =>
  NodeCrypto.createHmac("sha256", key).update(data).digest()

/**
 * Recomputes the AWS Signature Version 4 of `request` the way the service
 * does, from the request as sent, so a signature the service would reject
 * fails here too. Canonical URI segments are encoded once more because the
 * request path is already percent-encoded (Bedrock is not S3).
 */
const verifySigV4 = (request: HttpClientRequest.HttpClientRequest, secret: string) => {
  const authorization = request.headers["authorization"] ?? ""
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/
      .exec(authorization)
  if (match === null) {
    throw new Error(`Not a SigV4 authorization header: ${authorization}`)
  }
  const [, accessKeyId, date, region, service, signedHeaderList, actual] = match
  const signedHeaders = signedHeaderList.split(";")
  // The transport appends `urlParams` to `url` when it sends the request.
  const url = new URL(request.url)
  for (const [key, value] of request.urlParams) {
    url.searchParams.append(key, Redacted.isRedacted(value) ? Redacted.value(value) : value)
  }
  const canonicalQuery = Array.from(url.searchParams.entries())
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .sort()
    .join("&")
  const body = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array(0)
  const canonicalHeaders = signedHeaders
    .map((name) => `${name}:${name === "host" ? url.host : (request.headers[name] ?? "").trim()}\n`)
    .join("")
  const canonicalRequest = [
    request.method,
    url.pathname.split("/").map(encodeRfc3986).join("/"),
    canonicalQuery,
    canonicalHeaders,
    signedHeaderList,
    sha256Hex(body)
  ].join("\n")
  const scope = `${date}/${region}/${service}/aws4_request`
  const stringToSign = ["AWS4-HMAC-SHA256", request.headers["x-amz-date"], scope, sha256Hex(canonicalRequest)].join(
    "\n"
  )
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), "aws4_request")
  const expected = Buffer.from(hmac(signingKey, stringToSign)).toString("hex")
  return { accessKeyId, date, region, service, signedHeaders, actual, expected }
}
