import * as Fly from "@/Fly";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const SECURE_USERS_BODY = "users-on-the-stack-network";

/**
 * Private Service on the stack's own network: only Services on that
 * network can resolve it.
 */
export default class SecureUsers extends Fly.Service<SecureUsers>()(
  "SecureUsers",
  Effect.gen(function* () {
    return {
      main: import.meta.url,
      region: "iad",
      public: false,
      network: yield* Fly.stackNetwork,
      guest: { cpuKind: "shared" as const, cpus: 1, memoryMb: 256 },
    };
  }),
  Effect.gen(function* () {
    return {
      fetch: Effect.succeed(HttpServerResponse.text(SECURE_USERS_BODY)),
    };
  }),
) {}
