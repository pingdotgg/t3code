import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { Sandbox } from "./Sandbox.ts";

const _agentEff = Effect.gen(function* () {
  const agent1 = yield* Agent;
  const _binding1 = agent1.getByName("");

  const agent2 = yield* Agent2;
  const _binding2 = agent2.getByName("");

  const agent3 = yield* Agent3;
  const _binding3 = agent3.getByName("");
});

const _gen = Effect.gen(function* () {
  // bind the Sandbox Container to the Agent DO
  const sandbox = yield* Sandbox;

  return Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    // get the container instance
    sandbox.getTcpPort(1080);
    sandbox.getUser();

    return {
      getProfile: () => state.storage.get<string>("Profile"),
    };
  }).pipe(
    Effect.provide(
      Cloudflare.Containers.layer(Sandbox, {
        enableInternet: true,
      }),
    ),
  );
});

export const Agent2 = Cloudflare.DurableObject(
  "Agents",
  Effect.gen(function* () {
    // bind the Sandbox Container to the Agent DO
    const sandbox = yield* Sandbox;
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      sandbox.getTcpPort(1080);
      sandbox.getUser();

      return {
        getProfile: () => state.storage.get<string>("Profile"),
      };
    });
  }).pipe(
    Effect.provide(
      Cloudflare.Containers.layer(Sandbox, {
        enableInternet: true,
      }),
    ),
  ),
);

export class Agent3 extends Cloudflare.DurableObject<Agent3>()(
  "Agents",
  Effect.gen(function* () {
    // bind the Sandbox Container to the Agent DO
    const sandbox = yield* Sandbox;
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      // get the container instance
      sandbox.getTcpPort(1080);
      sandbox.getUser();

      return {
        getProfile: () => state.storage.get<string>("Profile"),
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

export default class Agent extends Cloudflare.DurableObject<Agent>()(
  "Agents",
  Effect.gen(function* () {
    // bind the Sandbox Container to the Agent DO
    const sandbox = yield* Sandbox;
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      const connection = yield* sandbox.getTcpPort(1080);

      const sessions = new Map<string, Cloudflare.WebSocket>();

      for (const socket of yield* state.getWebSockets()) {
        const session = socket.deserializeAttachment<{ id: string }>();
        if (session) {
          sessions.set(session.id, socket);
        }
      }

      return {
        getProfile: () => state.storage.get<string>("Profile"),
        putProfile: Effect.fn(function* (value: string) {
          yield* state.storage.put("Profile", value);
        }),
        eval: (code: string) =>
          connection
            .fetch(
              HttpClientRequest.post("/eval", {
                body: HttpBody.text(code),
              }),
            )
            .pipe(
              Effect.flatMap((response) => response.text),
              Effect.orDie,
            ),
        fetch: Effect.gen(function* () {
          const [response, socket] = yield* Cloudflare.upgrade();
          const id = "TODO";
          socket.serializeAttachment({ id });
          sessions.set(id, socket);
          return response;
        }),
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
