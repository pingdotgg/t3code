import * as AWS from "@/AWS";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class KinesisVideoTestFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "KinesisVideoTestFunction",
) {}

export default KinesisVideoTestFunction.make(
  {
    main,
    url: true,
    // every route fans out to GetDataEndpoint/GetSignalingChannelEndpoint
    // plus the data-plane call; the 3s default is too tight
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const stream = yield* AWS.KinesisVideo.Stream("FixtureStream", {
      mediaType: "video/h264",
      dataRetention: "24 hours",
    });
    const channel = yield* AWS.KinesisVideo.SignalingChannel("FixtureChannel");

    const getHls = yield* AWS.KinesisVideo.GetHLSStreamingSessionURL(stream);
    const getDash = yield* AWS.KinesisVideo.GetDASHStreamingSessionURL(stream);
    const getClip = yield* AWS.KinesisVideo.GetClip(stream);
    const getImages = yield* AWS.KinesisVideo.GetImages(stream);
    const listFragments = yield* AWS.KinesisVideo.ListFragments(stream);
    const getFragmentMedia =
      yield* AWS.KinesisVideo.GetMediaForFragmentList(stream);
    const getIceServers = yield* AWS.KinesisVideo.GetIceServerConfig(channel);
    const getMedia = yield* AWS.KinesisVideo.GetMedia(stream);
    const joinStorage = yield* AWS.KinesisVideo.JoinStorageSession(channel);
    const joinStorageAsViewer =
      yield* AWS.KinesisVideo.JoinStorageSessionAsViewer(channel);
    const sendAlexaOffer =
      yield* AWS.KinesisVideo.SendAlexaOfferToMaster(channel);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        if (request.method === "GET" && pathname === "/info") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/hls") {
          // The fixture stream has no ingested media, so LIVE playback
          // deterministically fails with a typed error from the archived
          // media data plane — reaching it at all proves endpoint discovery,
          // IAM, and the signed call.
          const result = yield* Effect.result(getHls({ PlaybackMode: "LIVE" }));
          if (Result.isSuccess(result)) {
            return yield* HttpServerResponse.json({
              url: result.success.HLSStreamingSessionURL,
            });
          }
          return yield* HttpServerResponse.json({
            errorTag: result.failure._tag,
          });
        }

        if (request.method === "GET" && pathname === "/dash") {
          // Same shape as /hls — the empty stream deterministically returns
          // the archived-media data plane's typed no-fragments error.
          const result = yield* Effect.result(
            getDash({ PlaybackMode: "LIVE" }),
          );
          if (Result.isSuccess(result)) {
            return yield* HttpServerResponse.json({
              url: result.success.DASHStreamingSessionURL,
            });
          }
          return yield* HttpServerResponse.json({
            errorTag: result.failure._tag,
          });
        }

        if (request.method === "GET" && pathname === "/fragments") {
          // ListFragments on an empty (but retained) stream succeeds with an
          // empty page — a full data-plane round-trip. A FragmentSelector is
          // required whenever no NextToken is passed.
          const now = yield* Effect.sync(() => Date.now());
          const result = yield* Effect.result(
            listFragments({
              FragmentSelector: {
                FragmentSelectorType: "SERVER_TIMESTAMP",
                TimestampRange: {
                  StartTimestamp: new Date(now - 60_000),
                  EndTimestamp: new Date(now),
                },
              },
            }),
          );
          if (Result.isSuccess(result)) {
            return yield* HttpServerResponse.json({
              ok: true,
              count: (result.success.Fragments ?? []).length,
            });
          }
          return yield* HttpServerResponse.json({
            ok: false,
            errorTag: result.failure._tag,
          });
        }

        if (request.method === "GET" && pathname === "/clip") {
          const now = yield* Effect.sync(() => Date.now());
          const result = yield* Effect.result(
            getClip({
              ClipFragmentSelector: {
                FragmentSelectorType: "SERVER_TIMESTAMP",
                TimestampRange: {
                  StartTimestamp: new Date(now - 60_000),
                  EndTimestamp: new Date(now),
                },
              },
            }),
          );
          if (Result.isSuccess(result)) {
            return yield* HttpServerResponse.json({
              ok: true,
              contentType: result.success.ContentType,
            });
          }
          return yield* HttpServerResponse.json({
            ok: false,
            errorTag: result.failure._tag,
          });
        }

        if (request.method === "GET" && pathname === "/images") {
          const now = yield* Effect.sync(() => Date.now());
          const result = yield* Effect.result(
            getImages({
              ImageSelectorType: "SERVER_TIMESTAMP",
              StartTimestamp: new Date(now - 60_000),
              EndTimestamp: new Date(now),
              SamplingInterval: 3000,
              Format: "JPEG",
            }),
          );
          if (Result.isSuccess(result)) {
            return yield* HttpServerResponse.json({
              ok: true,
              count: (result.success.Images ?? []).length,
            });
          }
          return yield* HttpServerResponse.json({
            ok: false,
            errorTag: result.failure._tag,
          });
        }

        if (request.method === "GET" && pathname === "/fragment-media") {
          // A syntactically-valid but nonexistent fragment number — the
          // empty stream deterministically returns the typed no-fragment
          // error, proving the signed data-plane call.
          const result = yield* Effect.result(
            getFragmentMedia({
              Fragments: ["91343852333181432392682062607743920994"],
            }),
          );
          if (Result.isSuccess(result)) {
            return yield* HttpServerResponse.json({
              ok: true,
              contentType: result.success.ContentType,
            });
          }
          return yield* HttpServerResponse.json({
            ok: false,
            errorTag: result.failure._tag,
          });
        }

        if (request.method === "GET" && pathname === "/join-storage") {
          // The fixture channel has no media storage configured, so the
          // WEBRTC endpoint discovery (or the join call itself) fails with a
          // typed error — reaching it proves IAM + endpoint resolution.
          const result = yield* Effect.result(joinStorage());
          return yield* HttpServerResponse.json(
            Result.isSuccess(result)
              ? { ok: true }
              : { ok: false, errorTag: result.failure._tag },
          );
        }

        if (request.method === "GET" && pathname === "/join-storage-viewer") {
          const result = yield* Effect.result(
            joinStorageAsViewer({ clientId: "alchemy-test-viewer" }),
          );
          return yield* HttpServerResponse.json(
            Result.isSuccess(result)
              ? { ok: true }
              : { ok: false, errorTag: result.failure._tag },
          );
        }

        if (request.method === "GET" && pathname === "/alexa-offer") {
          // No master peer is connected to the fixture channel, so the
          // service either rejects the junk SDP payload with a typed
          // InvalidArgumentException or holds the offer for redelivery until
          // our bounded timeout — both prove endpoint discovery, IAM, and
          // the signed signaling call.
          const result = yield* Effect.result(
            sendAlexaOffer({
              SenderClientId: "alchemy-test-alexa",
              // base64("v=0") — a minimal, syntactically-plausible SDP stub
              MessagePayload: "dj0w",
            }).pipe(Effect.timeoutOption("5 seconds")),
          );
          if (Result.isSuccess(result)) {
            return yield* HttpServerResponse.json(
              Option.isNone(result.success)
                ? { ok: true, timedOut: true }
                : {
                    ok: true,
                    answered: result.success.value.Answer !== undefined,
                  },
            );
          }
          return yield* HttpServerResponse.json({
            ok: false,
            errorTag: result.failure._tag,
          });
        }

        if (request.method === "GET" && pathname === "/ice") {
          const config = yield* getIceServers({ ClientId: "alchemy-test" });
          return yield* HttpServerResponse.json({
            servers: (config.IceServerList ?? []).map((server) => ({
              uris: server.Uris ?? [],
              hasCredentials:
                server.Username !== undefined && server.Password !== undefined,
              ttl: server.Ttl,
            })),
          });
        }

        if (request.method === "GET" && pathname === "/media") {
          // The empty stream never produces fragments; the connection to the
          // per-stream media endpoint either opens (headers arrive) or idles
          // until the bounded timeout. Both prove the data-plane call was
          // accepted — auth/endpoint failures surface as typed errors.
          const result = yield* Effect.result(
            getMedia({
              StartSelector: { StartSelectorType: "EARLIEST" },
            }).pipe(Effect.timeoutOption("5 seconds")),
          );
          if (Result.isSuccess(result)) {
            if (Option.isNone(result.success)) {
              return yield* HttpServerResponse.json({
                ok: true,
                timedOut: true,
              });
            }
            return yield* HttpServerResponse.json({
              ok: true,
              contentType: result.success.value.ContentType,
            });
          }
          return yield* HttpServerResponse.json({
            ok: false,
            errorTag: result.failure._tag,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found" },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AWS.KinesisVideo.GetHLSStreamingSessionURLHttp,
        AWS.KinesisVideo.GetDASHStreamingSessionURLHttp,
        AWS.KinesisVideo.GetClipHttp,
        AWS.KinesisVideo.GetImagesHttp,
        AWS.KinesisVideo.ListFragmentsHttp,
        AWS.KinesisVideo.GetMediaForFragmentListHttp,
        AWS.KinesisVideo.GetIceServerConfigHttp,
        AWS.KinesisVideo.SendAlexaOfferToMasterHttp,
        AWS.KinesisVideo.GetMediaHttp,
        AWS.KinesisVideo.JoinStorageSessionHttp,
        AWS.KinesisVideo.JoinStorageSessionAsViewerHttp,
      ),
    ),
  ),
);
