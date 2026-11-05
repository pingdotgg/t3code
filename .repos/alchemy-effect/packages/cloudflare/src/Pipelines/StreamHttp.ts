import * as pipelines from "@distilled.cloud/cloudflare/pipelines";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { Self } from "alchemy/Self";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import { AccountApiToken } from "../ApiToken/AccountApiToken.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Credentials } from "../Credentials.ts";
import { requireLiveResource } from "../HttpBindingDev.ts";
import { authorizeWith } from "../HttpClientUtils.ts";
import { isLegacyPipeline, type LegacyPipeline } from "./LegacyPipeline.ts";
import type { Stream } from "./Stream.ts";
import { makeStreamClient, recordSchemaOf, toStreamSendError } from "./StreamCodec.ts";
import { StreamSendError, type WriteStreamClient } from "./WriteStream.ts";

/**
 * Shared scaffolding for the HTTP-ingest Pipelines clients
 * (`WriteStreamHttp`, `WriteStreamLocal` and the matching StreamSink
 * layers). Internal — not exported from the Pipelines barrel.
 */

/**
 * Injectable auth: runs a raw distilled op (which needs
 * `Credentials | HttpClient`) and discharges those requirements down to
 * {@link RuntimeContext}. The HTTP variant provides a minted token; the
 * Local variant provides the ambient current-credentials context.
 */
export interface StreamAuth {
  authorize: <A, E>(
    eff: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ) => Effect.Effect<A, E, RuntimeContext>;
}

/** Legacy pipelines have their own ingest endpoint; only streams are supported. */
export const legacyPipelineUnsupported = (layer: string) =>
  Effect.die(
    new StreamSendError({
      message: `${layer} supports Pipelines streams only; bind a LegacyPipeline with WriteStreamBinding.`,
      reason: "SendFailed",
    }),
  );

/**
 * Build the producer client over the stream's HTTP ingest endpoint
 * (`POST https://{stream_id}.ingest.cloudflare.com`, at most 5 MB per
 * request). The stream needs `http` enabled.
 */
export const makeWriteStreamHttpClient = (
  auth: StreamAuth,
  stream: Stream<any>,
  streamId: Effect.Effect<string>,
): WriteStreamClient<any> =>
  makeStreamClient({
    schema: recordSchemaOf(stream),
    raw: Effect.die(
      new StreamSendError({
        message: "The Pipelines HTTP client has no native binding; use send/sendEncoded.",
        reason: "SendFailed",
      }),
    ),
    sendEncoded: (records) =>
      streamId.pipe(
        Effect.flatMap((id) =>
          auth.authorize(pipelines.sendStreamRecords({ streamId: id, records: [...records] })),
        ),
        Effect.mapError(toStreamSendError),
        Effect.asVoid,
      ),
  });

/**
 * Mint (or reuse) the host's scoped {@link AccountApiToken}, grant it
 * `Pipelines Send`, bind its value into the host at deploy time, and
 * build the client with it.
 */
export const makeHttpStreamBinding = <Client>(options: {
  layer: string;
  makeClient: (client: WriteStreamClient<any>) => Client;
}) =>
  Effect.gen(function* () {
    const Token = yield* AccountApiToken;
    const self = yield* Self;

    return Effect.fn(function* (stream: Stream<any> | LegacyPipeline) {
      if (isLegacyPipeline(stream)) return yield* legacyPipelineUnsupported(options.layer);
      if (!globalThis.__ALCHEMY_RUNTIME__) yield* requireLiveResource(stream);
      const token = yield* Token(`${self.LogicalId}Token`);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const { accountId } = yield* CloudflareEnvironment.current;
        yield* token.bind`${stream.LogicalId}`({
          policies: [
            {
              effect: "allow",
              permissionGroups: ["Pipelines Send"],
              resources: {
                [`com.cloudflare.api.account.${accountId}`]: "*",
              },
            },
          ],
        });
      }
      const value = yield* token.value;
      const streamId = yield* stream.streamId;
      return options.makeClient(
        makeWriteStreamHttpClient({ authorize: authorizeWith({ value }) }, stream, streamId),
      );
    });
  });

/**
 * Build the client with the **current credentials** captured at layer
 * build (no Worker host, no minted token).
 */
export const makeLocalStreamBinding = <Client>(options: {
  layer: string;
  makeClient: (client: WriteStreamClient<any>) => Client;
}) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Credentials | HttpClient.HttpClient>();

    return Effect.fn(function* (stream: Stream<any> | LegacyPipeline) {
      if (isLegacyPipeline(stream)) return yield* legacyPipelineUnsupported(options.layer);
      // Deferred accessor — resolves the stream id at apply time, so a
      // stream created in the same deploy works. No `host.bind`.
      const streamId = yield* stream.streamId;
      return options.makeClient(
        makeWriteStreamHttpClient(
          { authorize: (eff) => eff.pipe(Effect.provideContext(context)) },
          stream,
          streamId,
        ),
      );
    });
  });
