import { upgradeWebSocket } from "@neon/functions";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type { RuntimeContext } from "../RuntimeContext.ts";
import { FunctionRequest } from "./FunctionEnvironment.ts";
import { FunctionUpgradeSockets } from "./FunctionUpgrade.ts";

/**
 * Upgrade the current request using Neon's native WebSocket implementation.
 * Return `response` unchanged; rebuilding it discards the native upgrade metadata.
 * Authenticate the caller before accepting a public Function connection.
 */
export const upgrade = (options?: {
  protocol?: string;
}): Effect.Effect<
  {
    socket: WebSocket;
    response: HttpServerResponse.HttpServerResponse;
  },
  never,
  RuntimeContext | FunctionRequest
> =>
  Effect.gen(function* () {
    const request = yield* FunctionRequest;
    const { socket, response } = yield* Effect.sync(() =>
      upgradeWebSocket(request, options),
    );
    yield* Effect.sync(() => FunctionUpgradeSockets.set(response, socket));
    return { socket, response: HttpServerResponse.raw(response) };
  });
