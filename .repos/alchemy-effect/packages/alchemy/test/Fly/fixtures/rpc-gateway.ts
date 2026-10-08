import * as Fly from "@/Fly";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import RpcOrders from "./rpc-orders.ts";
import RpcUsers from "./rpc-users.ts";

/**
 * Public Service on the stack network. Each route exercises one way of
 * calling the private Services.
 */
export default class RpcGateway extends Fly.Service<RpcGateway>()(
  "RpcGateway",
  Effect.gen(function* () {
    return {
      main: import.meta.url,
      region: "iad",
      network: yield* Fly.stackNetwork,
      guest: { cpuKind: "shared" as const, cpus: 1, memoryMb: 256 },
    };
  }),
  Effect.gen(function* () {
    const users = yield* Fly.bindService(RpcUsers);
    const orders = yield* Fly.bindService(RpcOrders);
    const admin = yield* Fly.bindEndpoint(RpcUsers, { port: 9000 });
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://gateway").pathname;
        if (path === "/users") {
          return yield* HttpServerResponse.json(yield* users.listUsers());
        }
        if (path === "/orders") {
          return yield* HttpServerResponse.json(yield* orders.listOrders());
        }
        if (path === "/stream") {
          const streamed = yield* users.streamUsers().pipe(Stream.runCollect);
          return yield* HttpServerResponse.json(Array.from(streamed));
        }
        if (path === "/http") {
          const response = yield* users.fetch(HttpClientRequest.get("/hello"));
          return HttpServerResponse.text(yield* response.text);
        }
        if (path === "/admin") {
          const response = yield* admin.client.get("/stats");
          return HttpServerResponse.text(
            `${yield* admin.host}:${admin.port} ${yield* response.text}`,
          );
        }
        return HttpServerResponse.text("gateway");
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(Cause.pretty(cause), { status: 502 }),
          ),
        ),
      ),
    };
  }),
) {}
