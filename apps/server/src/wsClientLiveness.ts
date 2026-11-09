import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { RpcServer } from "effect/rpc";

// Clients ping every 5 seconds. Hidden browser tabs can be throttled to one
// timer per minute, so silence has to outlast that before it means "gone".
const CLIENT_SILENCE_LIMIT = Duration.seconds(90);
// A reading client drains the socket at some rate, however slow. Bytes queued
// with no progress mean the peer stopped reading, as a suspended iOS app does.
const SEND_STALL_LIMIT = Duration.seconds(30);
const CHECK_INTERVAL = Duration.seconds(5);

export interface TransportProgress {
  /** Bytes written by the server that the kernel has not accepted yet. */
  readonly pendingBytes: number;
  /** Bytes the kernel has accepted so far. */
  readonly bytesWritten: number;
  /** Bytes received from the client so far. */
  readonly bytesRead: number;
}

export type ClientUnresponsiveReason = "client-silent" | "send-stalled";

export interface ClientUnresponsive {
  readonly reason: ClientUnresponsiveReason;
  readonly silentForMs: number;
  /** Raw bytes received since the last handled message; framing and buffering also count. */
  readonly bytesReadWhileSilent: number;
  readonly pendingBytes: number;
}

/** Suspended phones keep TCP alive with a zero window, hiding stale sockets from TCP/RPC checks.
 * awaitUnresponsive lets callers reset after CLIENT_SILENCE_LIMIT without inbound traffic
 * or SEND_STALL_LIMIT without send-queue progress. */
export const make = Effect.fn("wsClientLiveness.make")(function* (
  readProgress: () => TransportProgress,
) {
  const clock = yield* Clock.Clock;
  let lastHeardAt = clock.currentTimeMillisUnsafe();
  let lastProgressAt = lastHeardAt;
  const initial = readProgress();
  let lastBytesWritten = initial.bytesWritten;
  let bytesReadWhenHeard = initial.bytesRead;

  const observe = (protocol: RpcServer.Protocol["Service"]): RpcServer.Protocol["Service"] => ({
    ...protocol,
    run: (write) =>
      protocol.run((clientId, message) => {
        lastHeardAt = clock.currentTimeMillisUnsafe();
        bytesReadWhenHeard = readProgress().bytesRead;
        return write(clientId, message);
      }),
  });

  const silenceMs = Duration.toMillis(CLIENT_SILENCE_LIMIT);
  const stallMs = Duration.toMillis(SEND_STALL_LIMIT);
  const check = Effect.sync((): ClientUnresponsive | undefined => {
    const now = clock.currentTimeMillisUnsafe();
    const { pendingBytes, bytesWritten, bytesRead } = readProgress();
    if (pendingBytes === 0 || bytesWritten !== lastBytesWritten) {
      lastProgressAt = now;
      lastBytesWritten = bytesWritten;
    }
    const reason: ClientUnresponsiveReason | undefined =
      now - lastHeardAt >= silenceMs
        ? "client-silent"
        : now - lastProgressAt >= stallMs
          ? "send-stalled"
          : undefined;
    if (reason === undefined) return undefined;
    return {
      reason,
      silentForMs: now - lastHeardAt,
      bytesReadWhileSilent: bytesRead - bytesReadWhenHeard,
      pendingBytes,
    };
  });

  const awaitUnresponsive = Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(CHECK_INTERVAL);
      const unresponsive = yield* check;
      if (unresponsive !== undefined) return unresponsive;
    }
  });

  return { observe, awaitUnresponsive } as const;
});
