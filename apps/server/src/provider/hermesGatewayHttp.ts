import {
  HermesGatewayConnectionHello,
  HermesGatewayPluginToT3Message,
  HermesGatewayT3ToPluginMessage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import {
  HermesGatewayBroker,
  type HermesGatewayConnectionRegistration,
} from "./Services/HermesGatewayBroker.ts";
import { ProviderAdapterRequestError } from "./Errors.ts";

export const HERMES_GATEWAY_WEBSOCKET_PATH = "/api/hermes-gateway/ws";

const decodePluginFrame = Schema.decodeUnknownEffect(
  Schema.fromJsonString(HermesGatewayPluginToT3Message),
);
const encodeServerFrame = Schema.encodeSync(Schema.fromJsonString(HermesGatewayT3ToPluginMessage));
const isConnectionHello = Schema.is(HermesGatewayConnectionHello);

export const hermesGatewayWebSocketRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const broker = yield* HermesGatewayBroker;
    return HttpRouter.add(
      "GET",
      HERMES_GATEWAY_WEBSOCKET_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const socket = yield* Effect.orDie(request.upgrade);
        const write = yield* socket.writer;
        const registration = yield* Ref.make<Option.Option<HermesGatewayConnectionRegistration>>(
          Option.none(),
        );
        const transport = {
          send: (message: HermesGatewayT3ToPluginMessage) =>
            write(encodeServerFrame(message)).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: "hermes",
                    method: message.type,
                    detail: "Failed to write a Hermes gateway WebSocket frame.",
                    cause,
                  }),
              ),
            ),
          close: (code: number, reason: string) =>
            write(new Socket.CloseEvent(code, reason)).pipe(Effect.ignore),
        };

        yield* socket
          .runString((frame) =>
            Effect.gen(function* () {
              const message = yield* decodePluginFrame(frame);
              const current = yield* Ref.get(registration);

              if (Option.isNone(current)) {
                if (!isConnectionHello(message)) {
                  yield* transport.close(4002, "First message must be connection.hello");
                  return;
                }
                const registered = yield* broker
                  .registerConnection(message, transport)
                  .pipe(
                    Effect.tapError((rejected) =>
                      transport
                        .send(rejected)
                        .pipe(Effect.andThen(transport.close(4003, rejected.message))),
                    ),
                  );
                yield* Ref.set(registration, Option.some(registered));
                yield* transport.send(registered.accepted);
                return;
              }

              if (isConnectionHello(message)) {
                yield* transport.close(4002, "connection.hello may only be sent once");
                return;
              }
              yield* broker.receive(current.value, message);
            }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Rejected Hermes gateway WebSocket frame", { cause }).pipe(
                  Effect.andThen(transport.close(4002, "Invalid Hermes gateway message")),
                ),
              ),
            ),
          )
          .pipe(
            Effect.catch((cause) =>
              Effect.logDebug("Hermes gateway WebSocket disconnected", { cause }),
            ),
            Effect.ensuring(
              Ref.get(registration).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.void,
                    onSome: broker.disconnect,
                  }),
                ),
              ),
            ),
          );

        return HttpServerResponse.empty();
      }),
    );
  }),
);
