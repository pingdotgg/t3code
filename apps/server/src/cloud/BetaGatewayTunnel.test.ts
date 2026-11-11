// @effect-diagnostics nodeBuiltinImport:off - The session pipes gateway streams to a real local listener.
import * as NodeNet from "node:net";
import { describe, expect, it } from "vite-plus/test";

import { encodeFrame, makeTunnelSession, STREAM_WINDOW } from "./BetaGatewayTunnel.ts";

const DATA = 0;
const WINDOW_UPDATE = 1;
const PING = 2;
const SYN = 1;
const ACK = 2;
const FIN = 4;
const RST = 8;

interface Frame {
  readonly type: number;
  readonly flags: number;
  readonly id: number;
  readonly length: number;
  readonly payload: Uint8Array;
}

const decode = (bytes: Uint8Array): Frame => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    type: view.getUint8(1),
    flags: view.getUint16(2),
    id: view.getUint32(4),
    length: view.getUint32(8),
    payload: bytes.subarray(12),
  };
};

const text = (value: string) => new TextEncoder().encode(value);

const dataBytes = (frames: ReadonlyArray<Frame>, id: number) =>
  frames
    .filter((frame) => frame.type === DATA && frame.id === id)
    .reduce((size, frame) => size + frame.payload.byteLength, 0);

async function withOrigin(
  onConnection: (socket: NodeNet.Socket) => void,
  test: (port: number) => Promise<void>,
) {
  const server = NodeNet.createServer(onConnection);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await test((server.address() as NodeNet.AddressInfo).port);
  } finally {
    server.close();
  }
}

/** A fake gateway: it feeds frames to the session and records what the session sends back. */
function attach(port: number) {
  const frames: Array<Frame> = [];
  const waiters: Array<{ readonly ready: () => boolean; readonly resolve: () => void }> = [];
  const state = { admitted: false, closed: null as string | null };
  const session = makeTunnelSession({
    send: (bytes) => {
      frames.push(decode(bytes));
      for (const waiter of waiters.filter((candidate) => candidate.ready())) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    },
    connect: () => NodeNet.connect({ host: "127.0.0.1", port }),
    onAdmitted: () => {
      state.admitted = true;
    },
    onClose: (reason) => {
      state.closed = reason;
    },
  });
  const until = (ready: () => boolean) =>
    ready() ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ ready, resolve }));
  const admit = () => {
    session.receive(encodeFrame(WINDOW_UPDATE, SYN, 1, 0));
    session.receive(encodeFrame(DATA, 0, 1, 1, Uint8Array.of(1)));
    session.receive(encodeFrame(WINDOW_UPDATE, FIN, 1, 0));
  };
  return { session, frames, state, until, admit };
}

describe("beta gateway tunnel session", () => {
  it("confirms admission and carries a request to this server and back", async () => {
    await withOrigin(
      (socket) => socket.once("data", (chunk) => socket.end(`echo:${chunk.toString()}`)),
      async (port) => {
        const gateway = attach(port);
        gateway.admit();
        expect(gateway.state.admitted).toBe(true);
        // Frames may be split anywhere across WebSocket messages.
        const request = encodeFrame(DATA, 0, 3, 4, text("ping"));
        gateway.session.receive(encodeFrame(WINDOW_UPDATE, SYN, 3, 0));
        for (const byte of request) gateway.session.receive(Uint8Array.of(byte));
        await gateway.until(() => gateway.frames.some((f) => f.id === 3 && f.flags & FIN));

        const stream = gateway.frames.filter((frame) => frame.id === 3);
        expect(stream[0]).toMatchObject({ type: WINDOW_UPDATE, flags: ACK });
        expect(new TextDecoder().decode(stream[1]?.payload)).toBe("echo:ping");
        expect(stream.at(-1)).toMatchObject({ type: WINDOW_UPDATE, flags: FIN });
        expect(gateway.state.closed).toBeNull();
      },
    );
  });

  it("never sends past the gateway's window", async () => {
    const reply = new Uint8Array(STREAM_WINDOW + 1_000).fill(7);
    const { promise: originClosed, resolve: closeOrigin } = Promise.withResolvers<void>();
    await withOrigin(
      (socket) => {
        socket.on("close", () => closeOrigin());
        socket.end(reply);
      },
      async (port) => {
        const gateway = attach(port);
        gateway.admit();
        gateway.session.receive(encodeFrame(WINDOW_UPDATE, SYN, 3, 0));
        // The origin closes only after the session has read all of its reply.
        await originClosed;
        expect(dataBytes(gateway.frames, 3)).toBe(STREAM_WINDOW);
        expect(gateway.frames.some((frame) => frame.flags & FIN)).toBe(false);

        gateway.session.receive(encodeFrame(WINDOW_UPDATE, 0, 3, 1_000));
        await gateway.until(() => gateway.frames.some((f) => f.id === 3 && f.flags & FIN));
        expect(dataBytes(gateway.frames, 3)).toBe(reply.byteLength);
      },
    );
  });

  it("grants window as this server reads, and drops a gateway that overruns it", async () => {
    await withOrigin(
      (socket) => socket.resume(),
      async (port) => {
        const gateway = attach(port);
        gateway.admit();
        gateway.session.receive(encodeFrame(WINDOW_UPDATE, SYN, 3, 0));
        const half = new Uint8Array(STREAM_WINDOW / 2);
        gateway.session.receive(encodeFrame(DATA, 0, 3, half.byteLength, half));
        const granted = () =>
          gateway.frames.find((f) => f.type === WINDOW_UPDATE && f.id === 3 && f.length > 0);
        await gateway.until(() => granted() !== undefined);
        expect(granted()?.length).toBe(STREAM_WINDOW / 2);

        // Grants follow completed writes, so these arrive before any further grant.
        gateway.session.receive(encodeFrame(DATA, 0, 3, half.byteLength, half));
        gateway.session.receive(encodeFrame(DATA, 0, 3, half.byteLength, half));
        expect(gateway.state.closed).toBeNull();
        gateway.session.receive(encodeFrame(DATA, 0, 3, 1, Uint8Array.of(0)));
        expect(gateway.state.closed).toBe("gateway exceeded the stream window");
      },
    );
  });

  it("answers pings and resets a stream this server refuses", async () => {
    const closed = NodeNet.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as NodeNet.AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const gateway = attach(port);
    gateway.session.receive(encodeFrame(PING, SYN, 0, 7));
    expect(gateway.frames.at(-1)).toMatchObject({ type: PING, flags: ACK, length: 7 });

    gateway.admit();
    gateway.session.receive(encodeFrame(WINDOW_UPDATE, SYN, 3, 0));
    await gateway.until(() => gateway.frames.some((f) => f.id === 3 && f.flags & RST));
    expect(gateway.state.closed).toBeNull();
  });
});
