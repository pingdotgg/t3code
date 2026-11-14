import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Stream from "effect/Stream";
import { Tweets } from "./bound-resources.ts";
import { Static } from "./sidecars.ts";

/**
 * Effect-native sidecar with RPC methods. It binds the `Static` sidecar
 * and publishes to Pub/Sub as the service's account. Bound from
 * {@link ./service-bound-container.ts}.
 */
export default class Worker extends GCP.Run.Container<Worker>()(
  "Worker",
  {
    main: import.meta.url,
    port: 3000,
    startupProbe: { httpGet: { path: "/health" }, periodSeconds: 2, failureThreshold: 30 },
  },
  Effect.gen(function* () {
    const tweets = yield* Tweets;
    const publish = yield* GCP.PubSub.Publish(tweets);
    const web = yield* GCP.Run.bindPort(Static, 80);

    return {
      greet: (name: string) => Effect.succeed(`hello ${name}`),
      count: () => Stream.make(1, 2, 3),
      publish: (text: string) =>
        publish({ body: { messages: [{ data: btoa(text) }] } }).pipe(
          Effect.map(({ messageIds }) => messageIds?.length ?? 0),
          Effect.orDie,
        ),
      staticStatus: () =>
        web.client.get("/").pipe(
          Effect.map((response) => response.status),
          Effect.orDie,
        ),
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/health")) return HttpServerResponse.text("worker ok");
        return HttpServerResponse.text("not found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(GCP.PubSub.PublishHttp)),
) {}
