import type { ServerAuthDescriptor } from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import { ServerAuthPolicy, type ServerAuthPolicyShape } from "../Services/ServerAuthPolicy.ts";
import { SESSION_COOKIE_NAME } from "../utils.ts";
import { isLoopbackHost, isWildcardHost } from "../../startupAccess.ts";

export const makeServerAuthPolicy = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const isRemoteReachable = isWildcardHost(config.host) || !isLoopbackHost(config.host);

  const policy =
    config.mode === "desktop"
      ? isRemoteReachable
        ? "remote-reachable"
        : "desktop-managed-local"
      : isRemoteReachable
        ? "remote-reachable"
        : "loopback-browser";

  const bootstrapMethods: ServerAuthDescriptor["bootstrapMethods"] =
    policy === "desktop-managed-local"
      ? ["desktop-bootstrap"]
      : config.mode === "desktop" && policy === "remote-reachable"
        ? ["desktop-bootstrap", "one-time-token"]
        : ["one-time-token"];

  const descriptor: ServerAuthDescriptor = {
    policy,
    bootstrapMethods,
    sessionMethods: ["browser-session-cookie", "bearer-session-token"],
    sessionCookieName: SESSION_COOKIE_NAME,
  };

  return {
    getDescriptor: () => Effect.succeed(descriptor),
  } satisfies ServerAuthPolicyShape;
});

export const ServerAuthPolicyLive = Layer.effect(ServerAuthPolicy, makeServerAuthPolicy);
