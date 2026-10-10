import * as Fly from "@/Fly";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const USERS = [
  { id: "u1", name: "Ada" },
  { id: "u2", name: "Grace" },
];

/**
 * Private Service on the stack network. It serves methods to bound callers,
 * plain HTTP routes, and an admin port (9000) for `Fly.bindEndpoint`.
 */
export default class RpcUsers extends Fly.Service<RpcUsers>()(
  "RpcUsers",
  Effect.gen(function* () {
    return {
      main: import.meta.url,
      region: "iad",
      public: false,
      network: yield* Fly.stackNetwork,
      guest: { cpuKind: "shared" as const, cpus: 1, memoryMb: 256 },
      services: [
        {
          protocol: "tcp",
          internalPort: 3000,
          autostop: "off" as const,
          ports: [{ port: 80, handlers: ["http"] }],
        },
        {
          protocol: "tcp",
          internalPort: 3000,
          autostop: "off" as const,
          ports: [{ port: 9000, handlers: ["http"] }],
        },
      ],
    };
  }),
  Effect.gen(function* () {
    return {
      listUsers: () => Effect.succeed(USERS),
      getUser: (id: string) =>
        Effect.succeed(USERS.find((user) => user.id === id)),
      streamUsers: () => Stream.fromIterable(USERS),
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        return HttpServerResponse.text(
          `users-http ${request.headers["fly-forwarded-port"] ?? ""} ${request.url}`,
        );
      }),
    };
  }),
) {}
