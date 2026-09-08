import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as EffectContext from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";

/** Node transport preserves explicit Content-Length on file-backed uploads. */
export const PrismaHttpClientLive = NodeHttpClient.layerNodeHttp;

/**
 * The HTTP client Prisma artifact uploads run on. Kept as a Prisma-scoped
 * service — overriding the global `HttpClient.HttpClient` from
 * `Prisma.providers()` would hijack every other provider in the stack (e.g.
 * Cloudflare Worker script uploads break on node's chunked multipart
 * bodies). Live wiring provides the node transport here because the
 * S3-style presigned upload URLs require an explicit Content-Length, while
 * tests that stub the ambient `HttpClient` simply omit this service and the
 * upload falls back to the ambient client.
 */
export class PrismaUploadClient extends EffectContext.Service<
  PrismaUploadClient,
  HttpClient.HttpClient
>()("alchemy/Prisma/UploadClient") {}

export const PrismaUploadClientLive = Layer.effect(
  PrismaUploadClient,
  Effect.gen(function* () {
    return yield* HttpClient.HttpClient;
  }),
).pipe(Layer.provide(PrismaHttpClientLive));
