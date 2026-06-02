import type { ServerAuthDescriptor } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import { resolveSessionCookieName } from "./utils.ts";
import { isLoopbackHost, isWildcardHost } from "../startupAccess.ts";

export interface EnvironmentAuthPolicyShape {
  readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
}

export class EnvironmentAuthPolicy extends Context.Service<
  EnvironmentAuthPolicy,
  EnvironmentAuthPolicyShape
>()("t3/auth/EnvironmentAuthPolicy") {}

export const make = Effect.fn("makeEnvironmentAuthPolicy")(function* () {
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
    sessionMethods: ["browser-session-cookie", "bearer-access-token"],
    sessionCookieName: resolveSessionCookieName({
      mode: config.mode,
      port: config.port,
    }),
  };

  return {
    getDescriptor: () =>
      Effect.succeed(descriptor).pipe(Effect.withSpan("EnvironmentAuthPolicy.getDescriptor")),
  } satisfies EnvironmentAuthPolicyShape;
});

export const layer = Layer.effect(EnvironmentAuthPolicy, make());
