import * as AWS from "@/AWS";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "iot-bindings-handler.ts");

// The MQTT topic namespace this fixture publishes retained messages into.
export const TOPIC_FILTER = "alchemy/iot/bindings/*";
export const RETAINED_TOPIC = "alchemy/iot/bindings/retained";

// Exercises every IoT runtime binding from inside a deployed Lambda:
// device shadows + DescribeThing on a Thing resource, retained messages via
// Publish/GetRetainedMessage/ListRetainedMessages, DescribeEndpoint and
// ListThings at account level, and the MQTT connection-management data
// plane (GetConnection/ListSubscriptions/DeleteConnection/SendDirectMessage)
// against a client id filter.
export class IoTBindingsFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "IoTBindingsFunction",
) {}

export default IoTBindingsFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const thing = yield* AWS.IoT.Thing("BindingsThing", {
      attributes: { purpose: "bindings-test" },
    });

    // thing-scoped
    const getShadow = yield* AWS.IoT.GetThingShadow(thing);
    const updateShadow = yield* AWS.IoT.UpdateThingShadow(thing);
    const deleteShadow = yield* AWS.IoT.DeleteThingShadow(thing);
    const listShadows = yield* AWS.IoT.ListNamedShadowsForThing(thing);
    const describeThing = yield* AWS.IoT.DescribeThing(thing);
    // topic-scoped
    const publish = yield* AWS.IoT.Publish(TOPIC_FILTER);
    const getRetained = yield* AWS.IoT.GetRetainedMessage(TOPIC_FILTER);
    // account-level
    const listRetained = yield* AWS.IoT.ListRetainedMessages();
    const describeEndpoint = yield* AWS.IoT.DescribeEndpoint();
    const listThings = yield* AWS.IoT.ListThings();
    // client-scoped
    const getConnection = yield* AWS.IoT.GetConnection("alchemy-bindings-*");
    const listSubscriptions =
      yield* AWS.IoT.ListSubscriptions("alchemy-bindings-*");
    const deleteConnection =
      yield* AWS.IoT.DeleteConnection("alchemy-bindings-*");
    const sendDirectMessage =
      yield* AWS.IoT.SendDirectMessage("alchemy-bindings-*");

    const thingName = yield* thing.thingName;

    const decodeShadowPayload = (
      payload: Stream.Stream<Uint8Array, Error> | undefined,
    ) =>
      payload === undefined
        ? Effect.succeed(undefined)
        : Stream.mkString(Stream.decodeText(payload));

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const shadowName = url.searchParams.get("shadowName") ?? undefined;

        if (request.method === "GET" && pathname === "/ready") {
          // `updateFunctionConfiguration` (which delivers the accessor env
          // vars) is eventually consistent: a sandbox that boots between the
          // code update and the config update runs the REAL code with the
          // STALE (pre-binding) env, and stays warm serving it. Report 503
          // until the env is visible so the test's readiness retry keeps
          // polling until Lambda retires the stale environment.
          const resolvedThingName = yield* thingName;
          if (!resolvedThingName) {
            return yield* HttpServerResponse.json(
              { ok: false, error: "binding env not yet propagated" },
              { status: 503 },
            );
          }
          return yield* HttpServerResponse.json({
            ok: true,
            thingName: resolvedThingName,
          });
        }

        if (request.method === "POST" && pathname === "/shadow") {
          const body = (yield* request.json) as {
            shadowName?: string;
            state: unknown;
          };
          const result = yield* updateShadow({
            shadowName: body.shadowName,
            payload: JSON.stringify({ state: body.state }),
          });
          const payload = yield* decodeShadowPayload(result.payload);
          return yield* HttpServerResponse.json({ ok: true, payload });
        }

        if (request.method === "GET" && pathname === "/shadow") {
          const result = yield* getShadow({ shadowName }).pipe(
            Effect.map((r) => ({ found: true as const, payload: r.payload })),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed({ found: false as const, payload: undefined }),
            ),
          );
          const payload = yield* decodeShadowPayload(result.payload);
          return yield* HttpServerResponse.json({
            found: result.found,
            payload,
          });
        }

        if (request.method === "GET" && pathname === "/shadow/list") {
          const result = yield* listShadows();
          return yield* HttpServerResponse.json({
            results: result.results ?? [],
          });
        }

        if (request.method === "DELETE" && pathname === "/shadow") {
          yield* deleteShadow({ shadowName }).pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/thing") {
          const result = yield* describeThing();
          return yield* HttpServerResponse.json({
            thingName: result.thingName,
            attributes: result.attributes ?? {},
          });
        }

        if (request.method === "GET" && pathname === "/things") {
          const result = yield* listThings();
          return yield* HttpServerResponse.json({
            thingNames: (result.things ?? []).map((t) => t.thingName),
          });
        }

        if (request.method === "GET" && pathname === "/endpoint") {
          const result = yield* describeEndpoint({
            endpointType: "iot:Data-ATS",
          });
          return yield* HttpServerResponse.json({
            endpointAddress: result.endpointAddress,
          });
        }

        if (request.method === "POST" && pathname === "/retained") {
          const body = (yield* request.json) as {
            topic: string;
            payload?: string;
          };
          // An empty retained payload clears the retained message.
          yield* publish({
            topic: body.topic,
            retain: true,
            qos: 1,
            payload: body.payload,
          });
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/retained") {
          const topic = url.searchParams.get("topic")!;
          const result = yield* getRetained({ topic }).pipe(
            Effect.map((r) => ({ found: true as const, payload: r.payload })),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed({ found: false as const, payload: undefined }),
            ),
          );
          const payload = result.payload
            ? yield* Effect.sync(() => new TextDecoder().decode(result.payload))
            : undefined;
          return yield* HttpServerResponse.json({
            found: result.found,
            payload,
          });
        }

        if (request.method === "GET" && pathname === "/retained/list") {
          const result = yield* listRetained();
          return yield* HttpServerResponse.json({
            topics: (result.retainedTopics ?? []).map((t) => t.topic),
          });
        }

        if (request.method === "GET" && pathname === "/connection") {
          const clientId = url.searchParams.get("clientId")!;
          const result = yield* getConnection({ clientId }).pipe(
            Effect.map((r) => ({
              ok: true as const,
              connected: r.connected ?? false,
            })),
            Effect.catchTag("ResourceNotFoundException", (e) =>
              Effect.succeed({
                ok: false as const,
                tag: "ResourceNotFoundException",
                message: e.message,
              }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/subscriptions") {
          const clientId = url.searchParams.get("clientId")!;
          const result = yield* listSubscriptions({ clientId }).pipe(
            Effect.map((r) => ({
              ok: true as const,
              subscriptions: r.subscriptions ?? [],
            })),
            Effect.catchTag("ResourceNotFoundException", (e) =>
              Effect.succeed({
                ok: false as const,
                tag: "ResourceNotFoundException",
                message: e.message,
              }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "DELETE" && pathname === "/connection") {
          const clientId = url.searchParams.get("clientId")!;
          const result = yield* deleteConnection({ clientId }).pipe(
            Effect.map(() => ({ ok: true as const })),
            Effect.catchTag("ResourceNotFoundException", (e) =>
              Effect.succeed({
                ok: false as const,
                tag: "ResourceNotFoundException",
                message: e.message,
              }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && pathname === "/direct") {
          const body = (yield* request.json) as {
            clientId: string;
            topic: string;
            payload?: string;
          };
          const result = yield* sendDirectMessage({
            clientId: body.clientId,
            topic: body.topic,
            payload: body.payload,
          }).pipe(
            Effect.map(() => ({ ok: true as const })),
            Effect.catchTag("ResourceNotFoundException", (e) =>
              Effect.succeed({
                ok: false as const,
                tag: "ResourceNotFoundException",
                message: e.message,
              }),
            ),
          );
          return yield* HttpServerResponse.json(result);
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
        AWS.IoT.GetThingShadowHttp,
        AWS.IoT.UpdateThingShadowHttp,
        AWS.IoT.DeleteThingShadowHttp,
        AWS.IoT.ListNamedShadowsForThingHttp,
        AWS.IoT.DescribeThingHttp,
        AWS.IoT.PublishHttp,
        AWS.IoT.GetRetainedMessageHttp,
        AWS.IoT.ListRetainedMessagesHttp,
        AWS.IoT.DescribeEndpointHttp,
        AWS.IoT.ListThingsHttp,
        AWS.IoT.GetConnectionHttp,
        AWS.IoT.ListSubscriptionsHttp,
        AWS.IoT.DeleteConnectionHttp,
        AWS.IoT.SendDirectMessageHttp,
      ),
    ),
  ),
);
