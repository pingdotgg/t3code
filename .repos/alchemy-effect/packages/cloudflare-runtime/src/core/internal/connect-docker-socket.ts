import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";

/**
 * Connect to the Docker unix socket with working half-close.
 *
 * A `docker exec` stream signals stdin EOF by shutting down the write half of
 * the socket while stdout/stderr keep flowing on the read half. Node supports
 * that with `allowHalfOpen`. Bun 1.3's `node:net` `Socket.end()` closes both
 * halves, so under Bun this wraps `Bun.connect`, whose `shutdown()` closes
 * only the write half, in a Node `Duplex`.
 *
 * Bun 1.3.x only (repo pins 1.3.13): with `allowHalfOpen`, `end()` still drops
 * data the peer sends afterwards. Fixed in Bun 1.4.0; once the repo moves to
 * Bun >= 1.4, use `NodeNet.createConnection` unconditionally and delete this.
 */
export const connectDockerSocket = (path: string): NodeStream.Duplex => {
  if (typeof Bun === "undefined") {
    return NodeNet.createConnection({ path, allowHalfOpen: true });
  }

  let socket: Bun.Socket | undefined;
  // The chunk being written and its completion callback. Bun's `write`
  // may accept only part of a chunk; the rest is retried on `drain`.
  let unwritten: Buffer | undefined;
  let onWritten: ((error?: Error | null) => void) | undefined;

  const writeUnwritten = () => {
    if (!socket || !unwritten) return;
    const accepted = socket.write(unwritten);
    unwritten = unwritten.subarray(accepted);
    if (unwritten.length > 0) return;

    unwritten = undefined;
    const callback = onWritten;
    onWritten = undefined;
    callback?.();
  };

  const stream: NodeStream.Duplex = new NodeStream.Duplex({
    allowHalfOpen: true,
    construct(callback) {
      Bun.connect({
        unix: path,
        allowHalfOpen: true,
        socket: {
          data(socket, data) {
            // Apply backpressure until Node asks for more via read().
            if (!stream.push(data)) socket.pause();
          },
          drain: writeUnwritten,
          end() {
            stream.push(null);
          },
          close() {
            if (onWritten) {
              stream.destroy(new Error("Docker socket closed during a write."));
            } else {
              stream.push(null);
            }
          },
          error(_socket, error) {
            stream.destroy(error);
          },
        },
      }).then((connected) => {
        socket = connected;
        callback();
      }, callback);
    },
    read() {
      socket?.resume();
    },
    write(chunk: Buffer, _encoding, callback) {
      unwritten = chunk;
      onWritten = callback;
      writeUnwritten();
    },
    final(callback) {
      // No argument means SHUT_WR. Despite the 1.3 type declaration,
      // `shutdown(true)` shuts down reads instead.
      socket?.shutdown();
      callback();
    },
    destroy(error, callback) {
      socket?.terminate();
      callback(error);
    },
  });
  return stream;
};
