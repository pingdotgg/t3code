import * as Fly from "@/Fly";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import RpcUsers from "./rpc-users.ts";

/**
 * A Service on the organization's default network that binds
 * {@link RpcUsers}, which is on the stack network. Deploying it fails.
 */
export default class RpcStranger extends Fly.Service<RpcStranger>()(
  "RpcStranger",
  {
    main: import.meta.url,
    region: "iad",
    public: false,
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
  },
  Effect.gen(function* () {
    const users = yield* Fly.bindService(RpcUsers);
    return {
      fetch: Effect.gen(function* () {
        return yield* HttpServerResponse.json(yield* users.listUsers());
      }).pipe(Effect.orDie),
    };
  }),
) {}
