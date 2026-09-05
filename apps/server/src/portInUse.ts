import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import * as ServerConfig from "./config.ts";
import { readPersistedServerRuntimeState } from "./serverRuntimeState.ts";

/**
 * Raised instead of the platform's `ServeError` when the HTTP server cannot
 * bind. `holderPid` is only set when server-runtime.json names the same port,
 * which is as close to proof of a culprit as we get: the descriptor can be
 * stale or carry a reused pid, so the message says how to check.
 */
export class PortInUseError extends Schema.TaggedErrorClass<PortInUseError>()("PortInUseError", {
  host: Schema.String,
  port: Schema.Int,
  holderPid: Schema.optional(Schema.Int),
  serverRuntimeStatePath: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    const address = `Port ${this.port} on ${this.host} is already in use`;
    if (this.holderPid === undefined) {
      return `${address}. Stop whatever is listening there, or start T3 Code on another port with --port; 't3 service status' says whether the T3 Code background service is holding it.`;
    }
    return `${address} by a running T3 Code server (pid ${this.holderPid} per server-runtime.json). Stop that server first; 't3 service status' finds it when it is the background service. If that pid is not actually a T3 server (stale descriptor, reused pid), delete '${this.serverRuntimeStatePath}' and retry.`;
  }
}

/**
 * The bind failure reaches us wrapped: `@effect/platform-node` puts the errno
 * error inside a `ServeError`, Bun throws it as a defect. Both keep the
 * original under `cause`, so walk that chain. The depth cap is there because
 * nothing forbids a cyclic `cause`.
 */
const isAddressInUse = (value: unknown): boolean => {
  let current: unknown = value;
  for (let depth = 0; depth < 4 && Predicate.isObject(current); depth++) {
    if (Predicate.hasProperty(current, "code") && current.code === "EADDRINUSE") {
      return true;
    }
    current = Predicate.hasProperty(current, "cause") ? current.cause : undefined;
  }
  return false;
};

const reportsAddressInUse = <E>(cause: Cause.Cause<E>): boolean =>
  cause.reasons.some((reason) =>
    Cause.isFailReason(reason)
      ? isAddressInUse(reason.error)
      : Cause.isDieReason(reason) && isAddressInUse(reason.defect),
  );

/**
 * Replaces an EADDRINUSE bind failure with a message that names the port and,
 * when server-runtime.json corroborates it, the process holding it. Every
 * other failure passes through untouched.
 */
export const explainPortInUse = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catchCauseIf(effect, reportsAddressInUse, (cause) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const persisted = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
      const holderPid =
        Option.isSome(persisted) && persisted.value.port === config.port
          ? persisted.value.pid
          : undefined;

      return yield* new PortInUseError({
        host: config.host ?? "127.0.0.1",
        port: config.port,
        ...(holderPid === undefined ? {} : { holderPid }),
        serverRuntimeStatePath: config.serverRuntimeStatePath,
        cause: Cause.squash(cause),
      });
    }),
  );
