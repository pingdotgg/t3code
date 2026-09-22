import type { ServerAuthDescriptor } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { isRemoteReachableHost, resolveSessionCookieName } from "./utils.ts";

export class EnvironmentAuthPolicy extends Context.Service<
  EnvironmentAuthPolicy,
  {
    readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
  }
>()("t3/auth/EnvironmentAuthPolicy") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const isRemoteReachable = isRemoteReachableHost(config.host);

  let policy: ServerAuthDescriptor["policy"];
  if (config.unsafeNoAuth) {
    policy = "unsafe-no-auth";
  } else if (config.mode === "desktop") {
    policy = isRemoteReachable ? "remote-reachable" : "desktop-managed-local";
  } else {
    policy = isRemoteReachable ? "remote-reachable" : "loopback-browser";
  }

  const bootstrapMethods: ServerAuthDescriptor["bootstrapMethods"] = (() => {
    switch (policy) {
      case "unsafe-no-auth":
        return [];
      case "desktop-managed-local":
        return ["desktop-bootstrap"];
      case "remote-reachable":
        return config.mode === "desktop"
          ? ["desktop-bootstrap", "one-time-token"]
          : ["one-time-token"];
      case "loopback-browser":
        return ["one-time-token"];
      default: {
        const _exhaustive: never = policy;
        return _exhaustive;
      }
    }
  })();

  const descriptor: ServerAuthDescriptor = {
    policy,
    bootstrapMethods,
    sessionMethods: ["browser-session-cookie", "bearer-access-token", "dpop-access-token"],
    sessionCookieName: resolveSessionCookieName({
      mode: config.mode,
      port: config.port,
      host: config.host,
      instanceKey: config.stateDir,
      environmentId: yield* serverEnvironment.getEnvironmentId,
      development: config.devUrl !== undefined,
    }),
  };

  return EnvironmentAuthPolicy.of({
    getDescriptor: () =>
      Effect.succeed(descriptor).pipe(Effect.withSpan("EnvironmentAuthPolicy.getDescriptor")),
  });
});

export const layer = Layer.effect(EnvironmentAuthPolicy, make);
