import { checkEnvironmentKey } from "@t3tools/shared/secureChannelPeer";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Socket from "effect/socket/Socket";

import { ConnectionBlockedError, type PreparedConnection } from "../connection/model.ts";
import type * as Persistence from "../platform/persistence.ts";
import type * as ManagedRelay from "../relay/managedRelay.ts";

export interface SecureRpcChannel {
  /**
   * Wraps one raw RPC socket. With no key pinned, the first frame the environment seals pins the
   * key it presented: the environment only seals after it accepted this device's handshake.
   * `context` defaults to the environment ID; a media socket passes `mediaSocketContext`.
   */
  readonly wrap: (socket: Socket.Socket, context?: Uint8Array) => Effect.Effect<Socket.Socket>;
  /** True once the environment presented a key other than the pinned one. */
  readonly keyChanged: () => boolean;
}

/**
 * The secure channel for one RPC socket, or undefined to connect in plaintext. It runs when the
 * upgrade proof asked for it and the environment either advertises it or has a pinned key, so an
 * old server keeps working while a pinned environment cannot be downgraded by hiding the capability.
 */
export const prepareSecureRpcChannel = Effect.fn("clientRuntime.rpc.prepareSecureRpcChannel")(
  function* (
    connection: Pick<PreparedConnection, "environmentId" | "descriptor" | "secureChannelRequested">,
    services: {
      readonly signer: ManagedRelay.ManagedRelayDpopSigner["Service"] | undefined;
      readonly registrations: Persistence.ConnectionRegistrationStore["Service"] | undefined;
    },
  ) {
    if (connection.secureChannelRequested !== true) return undefined;
    const secureClientSocket = services.signer?.secureClientSocket;
    if (secureClientSocket === undefined) return undefined;
    const registrations = services.registrations;
    const environmentId = connection.environmentId;
    // A pin that cannot be read must not look like no pin, or a tunnel could re-pin its own key.
    const pinned =
      registrations === undefined
        ? undefined
        : Option.getOrUndefined(
            yield* registrations.environmentKey(environmentId).pipe(
              Effect.mapError(
                (error) =>
                  new ConnectionBlockedError({
                    reason: "configuration",
                    detail: error.message,
                    hop: "device",
                  }),
              ),
            ),
          );
    if (pinned === undefined && connection.descriptor?.capabilities.secureChannel !== true) {
      return undefined;
    }
    let presented: Uint8Array | undefined;
    let keyChanged = false;
    const pinOnFirstFrame = Effect.suspend(() => {
      const key = presented;
      presented = undefined;
      return key === undefined || registrations === undefined
        ? Effect.void
        : registrations.pinEnvironmentKey(environmentId, key).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not pin the environment's secure channel key.", {
                environmentId,
                error: error.message,
              }),
            ),
          );
    });
    return {
      // The proofs for this socket already loaded the key, and the signer keeps it.
      wrap: (socket, context = new TextEncoder().encode(environmentId)) =>
        secureClientSocket(socket, {
          context,
          verifyPeer: (input) =>
            Effect.sync(() => {
              const result = checkEnvironmentKey({ ...input, pinned });
              keyChanged ||= result === "key_changed";
              if (result === "trusted" && pinned === undefined) presented = input.publicKey.slice();
              return result === "trusted";
            }),
        }).pipe(
          Effect.orDie,
          Effect.map((secured) =>
            pinned !== undefined
              ? secured
              : Socket.make({
                  reader: Effect.map(secured.reader, (reader) => ({
                    ...reader,
                    pull: Effect.tap(reader.pull, () => pinOnFirstFrame),
                  })),
                  writer: secured.writer,
                }),
          ),
        ),
      keyChanged: () => keyChanged,
    } satisfies SecureRpcChannel;
  },
);
