# @effect/ai-amazon-bedrock

Amazon Bedrock provider for Effect's `LanguageModel`, built on the Bedrock Runtime Converse and ConverseStream APIs. Requests are signed with AWS Signature Version 4 or sent with a Bedrock API key, and the provider has no runtime dependencies beyond `effect`.

## Installation

```sh
npm install effect @effect/ai-amazon-bedrock
```

## Usage

Set `AWS_REGION` with either `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (plus `AWS_SESSION_TOKEN` for temporary keys) or `AWS_BEARER_TOKEN_BEDROCK`, then provide a Bedrock language model:

```ts
import { AmazonBedrockClient, AmazonBedrockLanguageModel } from "@effect/ai-amazon-bedrock"
import { Effect, Layer } from "effect"
import { LanguageModel } from "effect/ai"
import { Digest, Mac, SecureRandom } from "effect/crypto"
import { FetchHttpClient } from "effect/http"

const Sonnet = AmazonBedrockLanguageModel.layer({
  model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
}).pipe(
  Layer.provide(AmazonBedrockClient.layerConfig()),
  Layer.provide([
    FetchHttpClient.layer,
    Digest.layerWebCrypto,
    Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto))
  ])
)

const program = LanguageModel.generateText({
  prompt: "Describe Amazon Bedrock in one sentence."
}).pipe(Effect.provide(Sonnet))
```

## Requirements

The client requires an `HttpClient` for the transport and the `Digest` and `Mac` services of `effect/crypto` for the SHA-256 and HMAC of SigV4 signing, so you choose the implementation of each. The WebCrypto layers above run anywhere `crypto.subtle` exists. The platform packages provide both services in one layer: `NodeCrypto.layer` from `@effect/platform-node` and `BunCrypto.layer` from `@effect/platform-bun` run on `node:crypto`, and `BrowserCrypto.layer` and `DenoCrypto.layer` run on WebCrypto. A client that authenticates with an API key requires the two services as well but never calls them.

## Authentication

`AmazonBedrockClient.layer` accepts explicit keys (`accessKeyId`, `secretAccessKey`, `sessionToken`), an `apiKey`, or a `credentials` effect that resolves AWS credentials before every request. The `credentials` effect is where a credential provider such as `fromNodeProviderChain()` from `@aws-sdk/credential-providers` plugs in. `Effect.cachedWithTTL` returns the cached effect, so allocate the cache once while building the layer and pass what it returns:

```ts
import { fromNodeProviderChain } from "@aws-sdk/credential-providers"
import { AmazonBedrockClient } from "@effect/ai-amazon-bedrock"
import { NodeCrypto } from "@effect/platform-node"
import { Duration, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"

const provider = fromNodeProviderChain()

const BedrockClient = Layer.unwrap(Effect.gen(function*() {
  const credentials = yield* Effect.cachedWithTTL(Effect.promise(() => provider()), Duration.minutes(5))
  return AmazonBedrockClient.layer({ region: "eu-west-1", credentials })
})).pipe(Layer.provide([FetchHttpClient.layer, NodeCrypto.layer]))
```

`service.client` exposes the same authenticated `HttpClient` for Bedrock Runtime operations the service does not model.

`region`, `apiUrl` and `transformClient` customize HTTP access.

## Features

- Text generation and streaming, tool calls with every `toolChoice` mode, and tool results.
- Structured output through a forced tool by default, or through Converse's native `outputConfig.textFormat` with `structuredOutputs: true` in the model config.
- Reasoning blocks, which round-trip into later turns with their signature through the `"amazon-bedrock"` provider options.
- Prompt caching, opted into per message or part with `options: { "amazon-bedrock": { cachePoint: { type: "default" } } }`.
- Image and document file parts, sent as bytes.
- Model-specific parameters, such as extended thinking, through `additionalModelRequestFields` in the model config.

The client maps Bedrock's `x-amzn-errortype` exceptions and HTTP statuses to `AiError`, validates the CRC of every event stream frame, and fails a stream on an exception frame such as `throttlingException`.

## Credits

This provider builds on [`@wmaurer/effect-ai-amazon-bedrock`](https://github.com/wmaurer/effect-ai-amazon-bedrock). Tom McKenzie (grrowl) wrote the original event stream decoder, error mapping and test frame builders. Wayne Maurer (wmaurer) developed the tools, structured output, files, reasoning and caching support and offered the provider for upstream inclusion.
