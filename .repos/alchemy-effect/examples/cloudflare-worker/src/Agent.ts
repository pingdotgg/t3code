import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { Sandbox } from "./Sandbox.ts";

export default class Agent extends Cloudflare.DurableObject<Agent>()(
  "Agents",
  Effect.gen(function* () {
    const container = yield* Sandbox;
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      const sessions = new Map<string, Cloudflare.WebSocket>();

      for (const socket of yield* state.getWebSockets()) {
        const session = socket.deserializeAttachment<{ id: string }>();
        if (session) {
          sessions.set(session.id, socket);
        }
      }

      return {
        exec: (command: string) => container.exec(command).pipe(Effect.orDie),
        hello: () =>
          Effect.gen(function* () {
            const { fetch } = yield* container.getTcpPort(3000);
            const response = yield* fetch(
              HttpClientRequest.get("http://container/"),
            );
            return yield* response.text;
          }).pipe(Effect.orDie),
        increment: () =>
          Effect.gen(function* () {
            const { fetch } = yield* container.getTcpPort(3000);
            const response = yield* fetch(
              HttpClientRequest.post("http://container/increment"),
            );
            return yield* response.text;
          }).pipe(Effect.orDie),
        fetch: Effect.gen(function* () {
          const [response, socket] = yield* Cloudflare.upgrade();
          const id = "TODO";
          socket.serializeAttachment({ id });
          sessions.set(id, socket);
          return response;
        }).pipe(Effect.orDie),
        webSocketMessage: Effect.fn(function* (
          socket: Cloudflare.WebSocket,
          message: string | Uint8Array,
        ) {
          const session = socket.deserializeAttachment<{ id: string }>();
          if (!session) return;
          const text =
            typeof message === "string"
              ? message
              : new TextDecoder().decode(message);
          for (const peer of sessions.values()) {
            yield* peer.send(`[${session.id}] ${text}`);
          }
        }),
        webSocketClose: Effect.fn(function* (
          ws: Cloudflare.WebSocket,
          code: number,
          reason: string,
          _wasClean: boolean,
        ) {
          const session = ws.deserializeAttachment<{ id: string }>();
          if (session) {
            sessions.delete(session.id);
          }
          yield* ws.close(code, reason);
        }),
      };
    });
  }).pipe(
    Effect.provide(
      Cloudflare.Containers.layer(Sandbox, {
        enableInternet: true,
      }),
    ),
  ),
) {}
