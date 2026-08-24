import * as Lambda from "@/AWS/Lambda";
import * as MediaLive from "@/AWS/MediaLive";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class MediaLiveTestFunction extends Lambda.Function<Lambda.Function>()(
  "MediaLiveTestFunction",
) {}

export default MediaLiveTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    // The input the input-scoped binding is bound to. A URL_PULL input is
    // free, provisions in seconds, and needs no security group.
    const input = yield* MediaLive.Input("BindingInput", {
      type: "URL_PULL",
      sources: [{ Url: "https://example.com/stream/index.m3u8" }],
      tags: { fixture: "medialive-bindings" },
    });

    // Event source: subscribe the host to MediaLive state-change/alert
    // events. The deploy proves the EventBridge rule + invoke permission
    // wiring.
    yield* MediaLive.consumeChannelEvents(
      { kinds: ["state-change", "alert"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `medialive event: ${event["detail-type"]} ${event.detail.state ?? event.detail.message ?? ""}`,
          ),
        ),
    );

    const describeInput = yield* MediaLive.DescribeInput(input);
    const listChannels = yield* MediaLive.ListChannels();
    const listInputs = yield* MediaLive.ListInputs();

    const bound = {
      describeInput,
      listChannels,
      listInputs,
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

        // Read the input's live state — the fixture input idles DETACHED.
        if (request.method === "GET" && pathname === "/input") {
          const current = yield* describeInput();
          return yield* HttpServerResponse.json({
            state: current.State,
            type: current.Type,
            sourceUrls: (current.Sources ?? []).map((s) => s.Url),
          });
        }

        // Account-level enumerations.
        if (request.method === "GET" && pathname === "/channels") {
          const { Channels } = yield* listChannels({ MaxResults: 20 });
          return yield* HttpServerResponse.json({
            count: (Channels ?? []).length,
          });
        }
        if (request.method === "GET" && pathname === "/inputs") {
          const { Inputs } = yield* listInputs({ MaxResults: 20 });
          return yield* HttpServerResponse.json({
            count: (Inputs ?? []).length,
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
        MediaLive.DescribeInputHttp,
        MediaLive.ListChannelsHttp,
        MediaLive.ListInputsHttp,
      ),
    ),
  ),
);
