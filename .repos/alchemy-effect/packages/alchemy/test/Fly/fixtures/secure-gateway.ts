import * as Fly from "@/Fly";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import SecureUsers from "./secure-users.ts";

/** Public Service on the stack network that proxies to {@link SecureUsers}. */
export default class SecureGateway extends Fly.Service<SecureGateway>()(
  "SecureGateway",
  Effect.gen(function* () {
    return {
      main: import.meta.url,
      region: "iad",
      network: yield* Fly.stackNetwork,
      guest: { cpuKind: "shared" as const, cpus: 1, memoryMb: 256 },
    };
  }),
  Effect.gen(function* () {
    const users = yield* Fly.bindService(SecureUsers);
    return {
      fetch: Effect.gen(function* () {
        const response = yield* users.fetch(HttpClientRequest.get("/"));
        return HttpServerResponse.text(yield* response.text);
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
