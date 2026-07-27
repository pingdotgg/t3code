import * as IVS from "@/AWS/IVS";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class IvsTestFunction extends Lambda.Function<Lambda.Function>()(
  "IvsTestFunction",
) {}

export default IvsTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The channel the channel-scoped bindings are bound to. Nothing ever
    // broadcasts to it, so the data-plane ops observe the typed
    // ChannelNotBroadcasting behavior.
    const channel = yield* IVS.Channel("BindingChannel", {
      type: "BASIC",
      latencyMode: "NORMAL",
      tags: { fixture: "ivs-bindings" },
    });

    // Event source: subscribe the host to IVS stream state-change events.
    // The deploy proves the EventBridge rule + invoke permission wiring.
    yield* IVS.consumeStreamEvents(
      { kinds: ["stream-state-change", "recording-state-change"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `ivs event: ${event.detail.channel_name} ${event.detail.event_name}`,
          ),
        ),
    );

    // Accessor for the channel's ARN, resolvable inside the runtime fetch
    // handler (the batch revocation request shape carries explicit
    // channel ARNs rather than binding to a single channel).
    const ChannelArn = yield* channel.channelArn;

    const getStream = yield* IVS.GetStream(channel);
    const getStreamSession = yield* IVS.GetStreamSession(channel);
    const listStreamSessions = yield* IVS.ListStreamSessions(channel);
    const putMetadata = yield* IVS.PutMetadata(channel);
    const stopStream = yield* IVS.StopStream(channel);
    const revokeViewerSession =
      yield* IVS.StartViewerSessionRevocation(channel);
    const insertAdBreak = yield* IVS.InsertAdBreak(channel);
    const listStreams = yield* IVS.ListStreams();
    const batchRevokeViewerSessions =
      yield* IVS.BatchStartViewerSessionRevocation();

    const bound = {
      getStream,
      getStreamSession,
      listStreamSessions,
      putMetadata,
      stopStream,
      revokeViewerSession,
      insertAdBreak,
      listStreams,
      batchRevokeViewerSessions,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        // Live-stream read on an idle channel: the typed
        // ChannelNotBroadcasting tag is the real observable behavior.
        if (request.method === "GET" && pathname === "/stream") {
          const result = yield* getStream().pipe(
            Effect.map(({ stream }) => ({
              live: true,
              viewers: stream?.viewerCount ?? 0,
            })),
            Effect.catchTag("ChannelNotBroadcasting", () =>
              Effect.succeed({ live: false, viewers: 0 }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // Latest session on a channel that never broadcast: typed
        // not-found.
        if (request.method === "GET" && pathname === "/session") {
          const result = yield* getStreamSession({}).pipe(
            Effect.map(({ streamSession }) => ({
              found: true,
              streamId: streamSession?.streamId,
            })),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed({ found: false, streamId: undefined }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // Channel-scoped session history (empty for the idle fixture).
        if (request.method === "GET" && pathname === "/sessions") {
          const { streamSessions } = yield* listStreamSessions({
            maxResults: 10,
          });
          return yield* HttpServerResponse.json({
            count: streamSessions.length,
          });
        }

        // Account-level live-stream enumeration.
        if (request.method === "GET" && pathname === "/streams") {
          const { streams } = yield* listStreams();
          return yield* HttpServerResponse.json({
            count: streams.length,
          });
        }

        // Timed-metadata insert requires a live stream — the idle channel
        // answers with the typed ChannelNotBroadcasting tag.
        if (request.method === "POST" && pathname === "/metadata") {
          const result = yield* putMetadata({
            metadata: JSON.stringify({ hello: "viewers" }),
          }).pipe(
            Effect.map(() => ({ inserted: true, tag: undefined })),
            Effect.catchTag("ChannelNotBroadcasting", (e) =>
              Effect.succeed({ inserted: false, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // Stopping an idle channel: typed ChannelNotBroadcasting.
        if (request.method === "POST" && pathname === "/stop") {
          const result = yield* stopStream().pipe(
            Effect.map(() => ({ stopped: true, tag: undefined })),
            Effect.catchTag(
              ["ChannelNotBroadcasting", "StreamUnavailable"],
              (e) => Effect.succeed({ stopped: false, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // Viewer session revocation is fire-and-forget; report the typed
        // outcome either way.
        if (request.method === "POST" && pathname === "/revoke") {
          const result = yield* revokeViewerSession({
            viewerId: "alchemy-test-viewer",
          }).pipe(
            Effect.map(() => ({
              ok: true,
              tag: undefined as string | undefined,
            })),
            Effect.catchTag(
              ["ValidationException", "PendingVerification"],
              (e) =>
                Effect.succeed({
                  ok: false,
                  tag: e._tag as string | undefined,
                }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // Server-side ad insertion requires a live stream (and an ad
        // configuration); report the typed outcome.
        if (request.method === "POST" && pathname === "/adbreak") {
          const result = yield* insertAdBreak({ durationSeconds: 30 }).pipe(
            Effect.map(({ adBreakId }) => ({
              inserted: true,
              adBreakId,
              tag: undefined as string | undefined,
            })),
            Effect.catchTag(
              [
                "ChannelNotBroadcasting",
                "ValidationException",
                "ConflictException",
              ],
              (e) =>
                Effect.succeed({
                  inserted: false,
                  adBreakId: undefined,
                  tag: e._tag as string | undefined,
                }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // Batch revocation across channels — per-pair failures surface in
        // the response's `errors` array rather than failing the call.
        if (request.method === "POST" && pathname === "/revoke-batch") {
          const channelArn = yield* ChannelArn;
          const { errors } = yield* batchRevokeViewerSessions({
            viewerSessions: [{ channelArn, viewerId: "alchemy-test-viewer" }],
          });
          return yield* HttpServerResponse.json({
            errorCount: (errors ?? []).length,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.EventSource,
        IVS.GetStreamHttp,
        IVS.GetStreamSessionHttp,
        IVS.ListStreamSessionsHttp,
        IVS.PutMetadataHttp,
        IVS.StopStreamHttp,
        IVS.StartViewerSessionRevocationHttp,
        IVS.InsertAdBreakHttp,
        IVS.ListStreamsHttp,
        IVS.BatchStartViewerSessionRevocationHttp,
      ),
    ),
  ),
);
