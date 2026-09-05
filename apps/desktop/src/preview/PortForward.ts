// @effect-diagnostics globalTimers:off -- This Node socket adapter owns cancellable connection deadlines outside the Effect runtime.
import * as NodeNet from "node:net";
import * as NodeTimers from "node:timers";

const WINDOW_BYTES = 256 * 1024;
const FRAME_BYTES = 64 * 1024;
const MAX_STREAMS = 32;
const MAX_FORWARDS = 32;

interface Stream {
  socket: NodeNet.Socket;
  connected: boolean;
  remoteEnded: boolean;
  sendCredit: number;
  receiveCredit: number;
  timeout: ReturnType<typeof NodeTimers.setTimeout>;
}

interface Forward {
  ensure(websocketUrl: string): Promise<number>;
  close(): void;
}

function createForward(): Forward {
  let websocket: WebSocket | null = null;
  const streams = new Map<number, Stream>();
  const sockets = new Set<NodeNet.Socket>();
  const server = NodeNet.createServer({ allowHalfOpen: true });
  let nextId = 1;
  let closed = true;
  let disposed = false;
  let ready: Promise<number> | null = null;
  let rejectReady: ((reason: Error) => void) | null = null;
  let connectTimeout: ReturnType<typeof NodeTimers.setTimeout> | undefined;

  const close = (error = new Error("Preview forwarding connection closed.")) => {
    if (closed) return;
    closed = true;
    NodeTimers.clearTimeout(connectTimeout);
    rejectReady?.(error);
    ready = null;
    for (const stream of streams.values()) {
      NodeTimers.clearTimeout(stream.timeout);
      stream.socket.destroy();
    }
    streams.clear();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    websocket?.close();
    websocket = null;
  };

  const send = (id: number, opcode: number, payload?: Uint8Array) => {
    if (closed || !websocket) return;
    const frame = Buffer.allocUnsafe(5 + (payload?.byteLength ?? 0));
    frame.writeUInt32BE(id, 0);
    frame[4] = opcode;
    if (payload) frame.set(payload, 5);
    try {
      websocket.send(frame);
    } catch {
      close();
    }
  };
  const remove = (id: number, notify: boolean) => {
    const stream = streams.get(id);
    if (!stream) return;
    streams.delete(id);
    NodeTimers.clearTimeout(stream.timeout);
    if (notify) send(id, 2);
    stream.socket.destroy();
  };
  const pump = (id: number, stream: Stream) => {
    // Read only the available credit. Node retains the bounded unread TCP buffer.
    while (stream.connected && stream.sendCredit > 0 && streams.get(id) === stream) {
      const size = Math.min(FRAME_BYTES, stream.sendCredit, stream.socket.readableLength);
      if (size === 0) break;
      const chunk: Buffer | null = stream.socket.read(size);
      if (!chunk) break;
      stream.sendCredit -= chunk.length;
      send(id, 1, chunk);
    }
  };

  server.on("connection", (socket) => {
    if (
      closed ||
      websocket?.readyState !== WebSocket.OPEN ||
      sockets.size >= MAX_STREAMS ||
      nextId > 0xffffffff
    ) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    sockets.add(socket);
    const id = nextId++;
    const stream: Stream = {
      socket,
      connected: false,
      remoteEnded: false,
      sendCredit: WINDOW_BYTES,
      receiveCredit: WINDOW_BYTES,
      timeout: NodeTimers.setTimeout(() => remove(id, true), 15_000),
    };
    streams.set(id, stream);
    socket.on("readable", () => pump(id, stream));
    socket.on("error", () => remove(id, true));
    socket.on("close", () => {
      sockets.delete(socket);
      remove(id, true);
    });
    socket.on("end", () => {
      if (stream.connected && streams.get(id) === stream) send(id, 4);
    });
    send(id, 0);
  });
  server.on("error", (error) => close(error));
  const handleMessage = (event: MessageEvent<unknown>) => {
    if (!(event.data instanceof ArrayBuffer) || event.data.byteLength < 5) {
      close(new Error("Invalid preview forwarding frame."));
      return;
    }
    const frame = Buffer.from(event.data);
    const id = frame.readUInt32BE(0);
    const opcode = frame[4];
    const payload = frame.subarray(5);
    if (
      id === 0 ||
      !(
        ((opcode === 0 || opcode === 2 || opcode === 4) && payload.length === 0) ||
        (opcode === 1 && payload.length > 0 && payload.length <= FRAME_BYTES) ||
        (opcode === 3 && payload.length === 4)
      )
    ) {
      close(new Error("Invalid preview forwarding frame."));
      return;
    }
    const stream = streams.get(id);
    // A local socket can close while its peer still has frames in flight.
    if (!stream) return;
    if (opcode === 0 && !stream.connected) {
      stream.connected = true;
      NodeTimers.clearTimeout(stream.timeout);
      pump(id, stream);
      if (stream.socket.readableEnded) send(id, 4);
    } else if (
      opcode === 1 &&
      stream.connected &&
      !stream.remoteEnded &&
      payload.length <= stream.receiveCredit
    ) {
      stream.receiveCredit -= payload.length;
      stream.socket.write(payload, (error) => {
        if (error || streams.get(id) !== stream) return;
        stream.receiveCredit += payload.length;
        const ack = Buffer.allocUnsafe(4);
        ack.writeUInt32BE(payload.length);
        send(id, 3, ack);
      });
    } else if (opcode === 2) {
      streams.delete(id);
      NodeTimers.clearTimeout(stream.timeout);
      stream.socket.end();
      stream.socket.setTimeout(15_000, () => stream.socket.destroy());
    } else if (opcode === 4 && stream.connected && !stream.remoteEnded) {
      stream.remoteEnded = true;
      stream.socket.end();
    } else if (opcode === 3 && stream.connected) {
      const consumed = payload.readUInt32BE(0);
      if (consumed === 0 || consumed > WINDOW_BYTES - stream.sendCredit) {
        close(new Error("Invalid preview forwarding credit."));
        return;
      }
      stream.sendCredit += consumed;
      pump(id, stream);
    } else {
      close(new Error("Unexpected preview forwarding frame."));
    }
  };

  return {
    ensure(websocketUrl) {
      if (disposed) return Promise.reject(new Error("Preview forwarding listener closed."));
      if (ready) return ready;
      const peer = new WebSocket(websocketUrl);
      peer.binaryType = "arraybuffer";
      websocket = peer;
      closed = false;
      ready = new Promise<number>((resolve, reject) => {
        rejectReady = reject;
        connectTimeout = NodeTimers.setTimeout(
          () => close(new Error("Preview forwarding connection timed out.")),
          15_000,
        );
        peer.addEventListener("open", () => {
          if (closed || websocket !== peer) return;
          const finish = () => {
            if (disposed) server.close();
            if (closed || websocket !== peer) return;
            const address = server.address();
            if (!address || typeof address === "string") {
              close(new Error("Preview forwarding listener did not get a port."));
              return;
            }
            NodeTimers.clearTimeout(connectTimeout);
            resolve(address.port);
          };
          // Retain the listener across relay disconnects so browser history and
          // cookies keep the same origin when a fresh ticket reconnects it.
          if (server.listening) finish();
          else server.listen(0, "127.0.0.1", finish);
        });
        peer.addEventListener("close", () => {
          if (websocket === peer) close();
        });
        peer.addEventListener("error", () => {
          if (websocket === peer) close();
        });
        peer.addEventListener("message", (event: MessageEvent<unknown>) => {
          if (websocket === peer) handleMessage(event);
        });
      });
      return ready;
    },
    close: () => {
      disposed = true;
      close();
      server.close();
    },
  };
}

/** Reuse one loopback listener and one multiplexed connection per preview target. */
export function createPreviewPortForwards() {
  const forwards = new Map<string, Forward>();
  return {
    async ensure(key: string, websocketUrl: string): Promise<number> {
      const existing = forwards.get(key);
      if (existing) return existing.ensure(websocketUrl);
      if (forwards.size >= MAX_FORWARDS) {
        throw new Error(
          "Too many preview targets. Restart the desktop app to clear unused forwards.",
        );
      }
      const forward = createForward();
      forwards.set(key, forward);
      return forward.ensure(websocketUrl);
    },
    close(): void {
      for (const forward of forwards.values()) forward.close();
      forwards.clear();
    },
  };
}
