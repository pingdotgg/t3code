import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";

// Reverse proxies close a socket after 60 seconds without upstream bytes
// (nginx proxy_read_timeout, AWS ALB), and a suspended client stops pinging.
export const SOCKET_HEARTBEAT_INTERVAL = Duration.seconds(20);

// RPC clients count any decoded frame as liveness and ignore unsolicited pongs.
export const SOCKET_HEARTBEAT_FRAME = '{"_tag":"Pong"}';

/** Server side: writes a heartbeat frame on an interval for as long as the writer is open. */
export function withSocketHeartbeat(socket: Socket.Socket): Socket.Socket {
  return Socket.make({
    reader: socket.reader,
    writer: Effect.tap(socket.writer, (writer) =>
      writer
        .write(SOCKET_HEARTBEAT_FRAME)
        .pipe(
          Effect.delay(SOCKET_HEARTBEAT_INTERVAL),
          Effect.forever,
          Effect.ignore,
          Effect.forkScoped,
        ),
    ),
  });
}
