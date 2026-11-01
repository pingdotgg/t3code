import { expect, it } from "vite-plus/test";

import {
  DISCORD_IPC_OP_FRAME,
  DISCORD_IPC_OP_CLOSE,
  DISCORD_IPC_OP_HANDSHAKE,
  DISCORD_IPC_OP_PING,
  DISCORD_IPC_OP_PONG,
  DiscordFrameDecoder,
  DiscordIpcClient,
  encodeDiscordFrame,
  resolveDiscordIpcPaths,
  type DiscordIpcSocket,
} from "./discordIpc.ts";

type Listener = (...args: unknown[]) => void;

/** In-memory stand-in for the Discord socket: records writes and lets tests reply. */
class FakeSocket {
  readonly writes: Buffer[] = [];
  destroyed = false;
  onWrite: ((chunk: Buffer) => void) | undefined;
  private readonly listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener): this {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  once(event: string, listener: Listener): this {
    const wrapper: Listener = (...args) => {
      this.removeListener(event, wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  removeListener(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  write(chunk: Buffer): boolean {
    this.writes.push(chunk);
    this.onWrite?.(chunk);
    return true;
  }

  end(): void {}
  destroy(): void {
    this.destroyed = true;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

/** Answers the handshake and announces connect, so `connect` can resolve. */
function connectFake(fake: FakeSocket, onHandshake?: (raw: string) => void) {
  fake.onWrite = (chunk) => {
    for (const frame of new DiscordFrameDecoder().push(chunk)) {
      if (frame.op !== DISCORD_IPC_OP_HANDSHAKE) continue;
      onHandshake?.(JSON.stringify(frame.data));
      fake.emit(
        "data",
        encodeDiscordFrame(DISCORD_IPC_OP_FRAME, { cmd: "DISPATCH", evt: "READY", data: {} }),
      );
    }
  };
  return () => {
    queueMicrotask(() => fake.emit("connect"));
    return fake as unknown as DiscordIpcSocket;
  };
}

const framesOf = (fake: FakeSocket, index: number) =>
  new DiscordFrameDecoder().push(fake.writes[index]!);

it("resolves Windows named pipes", () => {
  const paths = resolveDiscordIpcPaths("win32", {});
  expect(paths).toHaveLength(10);
  expect(paths[0]).toBe("\\\\?\\pipe\\discord-ipc-0");
  expect(paths[9]).toBe("\\\\?\\pipe\\discord-ipc-9");
});

it("prefers the XDG runtime dir on Linux and includes Flatpak and Snap", () => {
  const paths = resolveDiscordIpcPaths("linux", { XDG_RUNTIME_DIR: "/run/user/1000" });
  expect(paths[0]).toBe("/run/user/1000/discord-ipc-0");
  expect(paths).toContain("/run/user/1000/app/com.discordapp.Discord/discord-ipc-0");
  expect(paths).toContain("/run/user/1000/snap.discord/discord-ipc-0");
});

it("falls back to the temp dir and /tmp on macOS", () => {
  expect(resolveDiscordIpcPaths("darwin", { TMPDIR: "/var/folders/t/" })[0]).toBe(
    "/var/folders/t/discord-ipc-0",
  );
  expect(resolveDiscordIpcPaths("darwin", {})[0]).toBe("/tmp/discord-ipc-0");
});

it("round-trips a frame and reassembles one split across chunks", () => {
  const encoded = encodeDiscordFrame(DISCORD_IPC_OP_FRAME, { hello: "world" });
  expect(new DiscordFrameDecoder().push(encoded)).toEqual([
    { op: DISCORD_IPC_OP_FRAME, data: { hello: "world" } },
  ]);

  const decoder = new DiscordFrameDecoder();
  expect(decoder.push(encoded.subarray(0, 5))).toEqual([]);
  expect(decoder.push(encoded.subarray(5))).toEqual([
    { op: DISCORD_IPC_OP_FRAME, data: { hello: "world" } },
  ]);
});

it("handshakes, publishes activity, and clears on close", async () => {
  const fake = new FakeSocket();
  let clientId: string | null = null;
  const client = await DiscordIpcClient.connect({
    clientId: "1234567890",
    platform: "linux",
    environment: { XDG_RUNTIME_DIR: "/run/user/1000" },
    connect: connectFake(fake, (raw) => {
      clientId = (JSON.parse(raw) as { client_id: string }).client_id;
    }),
  });

  expect(clientId).toBe("1234567890");
  expect(framesOf(fake, 0)).toEqual([
    { op: DISCORD_IPC_OP_HANDSHAKE, data: { v: 1, client_id: "1234567890" } },
  ]);

  client.setActivity({ details: "In t3code", state: "Running an agent" });
  const [frame] = framesOf(fake, 1);
  expect(frame?.op).toBe(DISCORD_IPC_OP_FRAME);
  expect(frame?.data).toMatchObject({
    cmd: "SET_ACTIVITY",
    args: { pid: process.pid, activity: { details: "In t3code", state: "Running an agent" } },
  });

  client.setActivity(null);
  expect(framesOf(fake, 2)[0]?.data).toMatchObject({
    cmd: "SET_ACTIVITY",
    args: { activity: null },
  });

  client.close();
  expect(fake.destroyed).toBe(true);
});

it("answers Discord pings while connected", async () => {
  const fake = new FakeSocket();
  const client = await DiscordIpcClient.connect({
    clientId: "1",
    platform: "darwin",
    environment: { TMPDIR: "/tmp" },
    connect: connectFake(fake),
  });

  fake.emit("data", encodeDiscordFrame(DISCORD_IPC_OP_PING, { nonce: "p" }));
  const pong = framesOf(fake, 1)[0];
  expect(pong?.op).toBe(DISCORD_IPC_OP_PONG);
  expect(pong?.data).toEqual({ nonce: "p" });

  client.close();
});

it("reports an unexpected close through onClose", async () => {
  const fake = new FakeSocket();
  const failed = new FakeSocket();
  failed.onWrite = () => failed.emit("close");
  let attempts = 0;
  const closes: Array<Error | null> = [];
  await DiscordIpcClient.connect({
    clientId: "1",
    platform: "darwin",
    environment: { TMPDIR: "/tmp" },
    connect: () => {
      attempts += 1;
      if (attempts > 1) return connectFake(fake)();
      queueMicrotask(() => failed.emit("connect"));
      return failed as unknown as DiscordIpcSocket;
    },
    onClose: (error) => closes.push(error),
  });

  expect(attempts).toBe(2);
  expect(failed.destroyed).toBe(true);
  expect(closes).toEqual([]);
  fake.emit("close");
  expect(closes).toEqual([null]);
});

it.each(["close frame", "write failure"])("destroys the transport on %s", async (failure) => {
  const fake = new FakeSocket();
  const closes: Array<Error | null> = [];
  const client = await DiscordIpcClient.connect({
    clientId: "1",
    platform: "darwin",
    environment: { TMPDIR: "/tmp" },
    connect: connectFake(fake),
    onClose: (error) => closes.push(error),
  });
  if (failure === "close frame") {
    fake.emit("data", encodeDiscordFrame(DISCORD_IPC_OP_CLOSE, {}));
  } else {
    fake.onWrite = () => {
      throw new Error("write failed");
    };
    client.setActivity({ state: "Idle" });
  }
  expect(fake.destroyed).toBe(true);
  expect(closes).toHaveLength(1);
  client.close();
  fake.emit("close");
  expect(closes).toHaveLength(1);
});

it("rejects when the handshake never completes", async () => {
  const fake = new FakeSocket();
  const neverReady = () => {
    queueMicrotask(() => fake.emit("connect"));
    return fake as unknown as DiscordIpcSocket;
  };
  await expect(
    DiscordIpcClient.connect({
      clientId: "1",
      platform: "darwin",
      environment: { TMPDIR: "/tmp" },
      connect: neverReady,
      handshakeTimeoutMs: 1,
    }),
  ).rejects.toThrow();
});
