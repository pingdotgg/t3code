import { describe, expect, it, vi } from "vite-plus/test";

import {
  createOrbitGatewayClient,
  type OrbitGatewayRequest,
  type OrbitGatewayTransport,
} from "./client.ts";
import {
  createOrbitProfileLive,
  ORBIT_PROFILE_CHECK_MS,
  orbitProfileNotice,
} from "./profileLive.ts";
import type { OrbitRealtimeSocket } from "./realtimeSubscription.ts";

function clock() {
  vi.useFakeTimers();
  return {
    [Symbol.dispose]() {
      vi.useRealTimers();
    },
  };
}

const key = (n: number) => n.toString(16).padStart(32, "0");

/**
 * A Gateway that follows the item 2 contract: `/me` names `private-conn-profile.{key}`, discovery
 * and auth live under `/api/v1/conn`, auth admits only the caller's current channel, and a write
 * sends `{profile_id, version}` to the current key only.
 */
function fakeGateway() {
  const gateway = {
    profileId: 1 as number | null,
    version: 5,
    keyNumber: 1,
    access: true,
    /** The refusal while `access` is false: a withdrawn peer, or the `conn` switch turned off. */
    refusal: { status: 403, code: "peer.identity_unknown" },
    /** A failing step after `/me` (the settings read) in the client's refresh. */
    failAfterMe: false,
    reverb: true,
    reads: 0,
    /** While set, `/me` answers with the state at request time once this settles. */
    hold: null as Promise<void> | null,
    requests: [] as OrbitGatewayRequest[],
    sockets: [] as Socket[],
  };
  const channel = () =>
    gateway.profileId === null ? null : `private-conn-profile.${key(gateway.keyNumber)}`;
  const json = (body: unknown, status = 200) => ({ status, body: JSON.stringify(body) });
  const transport: OrbitGatewayTransport = async (request) => {
    gateway.requests.push(request);
    if (!gateway.access) {
      const { status, code } = gateway.refusal;
      return json({ status, error: { code, message: "no", details: {} } }, status);
    }
    if (request.root) throw new Error("Conn profile realtime must stay under /api/v1/conn");
    switch (request.path) {
      case "/me": {
        gateway.reads += 1;
        const answer = json({
          data: {
            id: 7,
            name: "phone",
            wireguard_ip: "10.44.0.30",
            profile:
              gateway.profileId === null
                ? null
                : {
                    id: gateway.profileId,
                    name: "Main",
                    settings_version: gateway.version,
                    updated_at: "2026-11-18T00:00:00Z",
                  },
            profile_channel: channel(),
          },
        });
        if (gateway.hold) await gateway.hold;
        return answer;
      }
      case "/realtime":
        return json({
          data: gateway.reverb
            ? { url: "wss://reverb.orbit", key: "app" }
            : { url: null, key: null },
        });
      case "/broadcasting/auth": {
        const body = request.body as { socket_id?: string; channel_name?: string };
        if (!/^\d+\.\d+$/.test(body.socket_id ?? "") || body.channel_name !== channel()) {
          return json(
            {
              status: 403,
              error: { code: "broadcast.channel_forbidden", message: "no", details: {} },
            },
            403,
          );
        }
        return json({ auth: `app:${body.channel_name}:${body.socket_id}` });
      }
      default:
        return json({ status: 404, error: { code: "missing", message: "", details: {} } }, 404);
    }
  };

  class Socket implements OrbitRealtimeSocket {
    readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
    readonly socketId = `${gateway.sockets.length + 1}.1`;
    subscribedTo: string | null = null;
    closed = false;
    constructor() {
      void Promise.resolve().then(() =>
        this.emit("pusher:connection_established", { socket_id: this.socketId }),
      );
    }
    addEventListener(event: string, listener: (event: MessageEvent) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    }
    send(text: string) {
      const frame = JSON.parse(text);
      if (frame.event !== "pusher:subscribe") return;
      const { channel: name, auth } = frame.data;
      if (auth !== `app:${name}:${this.socketId}`) return;
      this.subscribedTo = name;
      void Promise.resolve().then(() =>
        this.emit("pusher_internal:subscription_succeeded", {}, name),
      );
    }
    close() {
      this.closed = true;
    }
    emit(event: string, data: unknown, channelName?: string) {
      if (this.closed) return;
      for (const listener of this.listeners.get("message") ?? [])
        listener(
          new MessageEvent("message", {
            data: JSON.stringify({ event, data: JSON.stringify(data), channel: channelName }),
          }),
        );
    }
    drop() {
      for (const listener of this.listeners.get("close") ?? []) listener(new MessageEvent("close"));
    }
  }

  return {
    gateway,
    transport,
    socket: () => {
      const socket = new Socket();
      gateway.sockets.push(socket);
      return socket;
    },
    /** A committed write. `deliver: false` is a broadcast Reverb lost. */
    write(deliver = true) {
      gateway.version += 1;
      if (!deliver || gateway.profileId === null) return;
      const current = channel();
      for (const socket of gateway.sockets) {
        if (socket.subscribedTo === current) {
          socket.emit(
            "conn.profile.updated",
            { profile_id: gateway.profileId, version: gateway.version },
            current!,
          );
        }
      }
    },
    /** A key replacement (renewal, bind, edge removal); the old key gets nothing from now on. */
    rotate() {
      gateway.keyNumber += 1;
    },
    open: () => gateway.sockets.filter((socket) => !socket.closed),
  };
}

function harness(options: { scope?: { value: string | null } } = {}) {
  const fake = fakeGateway();
  const client = createOrbitGatewayClient(fake.transport);
  const local = options.scope ?? { value: "orbit" as string | null };
  const applied: number[] = [];
  const live = createOrbitProfileLive({
    transport: fake.transport,
    scope: () => local.value,
    socket: fake.socket,
    refresh: async (isCurrent, observe) => {
      const me = await client.me();
      if (!isCurrent()) return null;
      observe(me.profileChannel ?? null);
      if (fake.gateway.failAfterMe) throw new Error("settings failed");
      if (me.profile === null) return null;
      applied.push(me.profile.settingsVersion);
      return {
        profileId: me.profile.id,
        version: me.profile.settingsVersion,
        channel: me.profileChannel ?? null,
      };
    },
  });
  return { ...fake, live, local, applied };
}

describe("orbitProfileNotice", () => {
  it("reads only the contract's event and payload", () => {
    expect(orbitProfileNotice("conn.profile.updated", { profile_id: 3, version: 9 })).toEqual({
      profileId: 3,
      version: 9,
    });
    expect(orbitProfileNotice("conn.profile.updated", '{"profile_id":3,"version":9}')).toEqual({
      profileId: 3,
      version: 9,
    });
    expect(orbitProfileNotice("conn.profile.updated", { profile_id: "3", version: 9 })).toBeNull();
    expect(orbitProfileNotice("record.updated", { profile_id: 3, version: 9 })).toBeNull();
  });
});

describe("Orbit profile live subscription", () => {
  it("subscribes to the channel /me names and reads exactly once per notice", async () => {
    using _clock = clock();
    const { gateway, live, write, applied, open } = harness();
    await live.resume();
    await vi.advanceTimersByTimeAsync(0);
    const channel = `private-conn-profile.${key(1)}`;
    expect(live.channel()).toBe(channel);
    expect(gateway.requests.find((request) => request.path === "/broadcasting/auth")).toMatchObject(
      { method: "POST", body: { socket_id: "1.1", channel_name: channel } },
    );
    expect(open()[0]!.subscribedTo).toBe(channel);
    // The initial read, then one more once live, for notices sent before the subscribe.
    expect(gateway.reads).toBe(2);

    write();
    await vi.advanceTimersByTimeAsync(0);
    expect(gateway.reads).toBe(3);
    expect(applied.at(-1)).toBe(6);

    // A duplicate, an older version and another profile start nothing.
    const socket = open()[0]!;
    socket.emit("conn.profile.updated", { profile_id: 1, version: 6 }, channel);
    socket.emit("conn.profile.updated", { profile_id: 1, version: 4 }, channel);
    socket.emit("conn.profile.updated", { profile_id: 2, version: 50 }, channel);
    await vi.advanceTimersByTimeAsync(0);
    expect(gateway.reads).toBe(3);
    live.dispose();
  });

  it("catches a dropped broadcast with the periodic version check", async () => {
    using _clock = clock();
    const { gateway, live, write, applied } = harness();
    await live.resume();
    await vi.advanceTimersByTimeAsync(0);
    const reads = gateway.reads;
    write(false);
    await vi.advanceTimersByTimeAsync(ORBIT_PROFILE_CHECK_MS - 1);
    expect(gateway.reads).toBe(reads);
    await vi.advanceTimersByTimeAsync(1);
    expect(gateway.reads).toBe(reads + 1);
    expect(applied.at(-1)).toBe(6);
    live.dispose();
  });

  it("reads the state again after a reconnect", async () => {
    using _clock = clock();
    const { gateway, live, write, applied, open } = harness();
    await live.resume();
    await vi.advanceTimersByTimeAsync(0);
    open()[0]!.drop();
    // A write while the socket was down never reaches this device as a notice.
    write();
    expect(applied.at(-1)).toBe(5);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(open()).toHaveLength(1);
    expect(gateway.sockets).toHaveLength(2);
    expect(applied.at(-1)).toBe(6);
    write();
    await vi.advanceTimersByTimeAsync(0);
    expect(applied.at(-1)).toBe(7);
    live.dispose();
  });

  it("resubscribes when the channel key rotates", async () => {
    using _clock = clock();
    const { gateway, live, write, applied, rotate, open } = harness();
    await live.resume();
    await vi.advanceTimersByTimeAsync(0);
    const first = open()[0]!;
    rotate();
    // The old key gets nothing any more; the next read finds the new channel.
    write();
    await vi.advanceTimersByTimeAsync(ORBIT_PROFILE_CHECK_MS);
    const second = open();
    expect(first.closed).toBe(true);
    expect(second).toHaveLength(1);
    expect(second[0]!.subscribedTo).toBe(`private-conn-profile.${key(2)}`);
    expect(live.channel()).toBe(`private-conn-profile.${key(2)}`);
    expect(applied.at(-1)).toBe(6);
    const reads = gateway.reads;
    write();
    await vi.advanceTimersByTimeAsync(0);
    expect(gateway.reads).toBe(reads + 1);
    expect(applied.at(-1)).toBe(7);
    live.dispose();
  });

  it("follows a rotated key even when the rest of that refresh fails", async () => {
    using _clock = clock();
    const { gateway, live, rotate, open } = harness();
    await live.resume();
    await vi.advanceTimersByTimeAsync(0);
    const first = open()[0]!;
    rotate();
    gateway.failAfterMe = true;
    await live.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.closed).toBe(true);
    expect(open()[0]!.subscribedTo).toBe(`private-conn-profile.${key(2)}`);
    live.dispose();
  });

  it("never applies an old binding's socket after a switch from A to B and back to A", async () => {
    using _clock = clock();
    const { gateway, live, applied, rotate, open } = harness();
    await live.resume();
    await vi.advanceTimersByTimeAsync(0);
    const oldSocket = gateway.sockets[0]!;
    const oldChannel = oldSocket.subscribedTo!;
    // This device binds B, then A again: every bind issues a new key.
    live.invalidate();
    gateway.profileId = 2;
    rotate();
    await live.reconcile();
    live.invalidate();
    gateway.profileId = 1;
    rotate();
    await live.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    expect(oldSocket.closed).toBe(true);
    expect(open()).toHaveLength(1);
    expect(live.channel()).toBe(`private-conn-profile.${key(3)}`);

    // A frame that was in flight to the old socket arrives late.
    const reads = gateway.reads;
    const listener = oldSocket.listeners.get("message")![0]!;
    listener(
      new MessageEvent("message", {
        data: JSON.stringify({
          event: "conn.profile.updated",
          data: JSON.stringify({ profile_id: 1, version: 99 }),
          channel: oldChannel,
        }),
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(gateway.reads).toBe(reads);
    expect(applied).not.toContain(99);
    live.dispose();
  });

  it("drops a read that was in flight when this device rebinds", async () => {
    using _clock = clock();
    const { gateway, live, write, applied, rotate } = harness();
    await live.resume();
    await vi.advanceTimersByTimeAsync(0);
    const release = Promise.withResolvers<void>();
    gateway.hold = release.promise;
    // A notice starts a read of A; the user switches to B before it answers.
    write();
    await vi.advanceTimersByTimeAsync(0);
    const staleVersion = gateway.version;
    live.invalidate();
    gateway.profileId = 2;
    gateway.version = 40;
    rotate();
    gateway.hold = null;
    const switched = live.reconcile();
    release.resolve();
    await switched;
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).not.toContain(staleVersion);
    expect(applied.at(-1)).toBe(40);
    const auths = gateway.requests.filter((request) => request.path === "/broadcasting/auth");
    expect(auths.at(-1)).toMatchObject({
      body: { channel_name: `private-conn-profile.${key(2)}` },
    });
    expect(
      auths.filter(
        (request) =>
          (request.body as { channel_name: string }).channel_name ===
          `private-conn-profile.${key(1)}`,
      ),
    ).toHaveLength(1);
    live.dispose();
  });

  it("drops a read that started in a scope the device has left", async () => {
    using _clock = clock();
    const scope = { value: "orbit" as string | null };
    const { gateway, live, open } = harness({ scope });
    await live.resume();
    await vi.advanceTimersByTimeAsync(0);
    // Orbit off, then on again: the old socket closes and only a new read subscribes.
    scope.value = null;
    await live.reconcile();
    expect(open()).toHaveLength(0);
    scope.value = "orbit";
    await live.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    expect(open()).toHaveLength(1);
    expect(gateway.sockets).toHaveLength(2);
    live.dispose();
  });

  it.each([
    { status: 403, code: "peer.identity_unknown" },
    { status: 409, code: "extension.disabled" },
  ])("stops the subscription when access or the binding is withdrawn ($code)", async (refusal) => {
    using _clock = clock();
    const { gateway, live, open } = harness();
    await live.resume();
    await vi.advanceTimersByTimeAsync(0);
    gateway.refusal = refusal;
    gateway.access = false;
    await live.reconcile();
    expect(open()).toHaveLength(0);
    expect(live.channel()).toBeNull();
    // Reads retry with backoff and subscribe again once access is back.
    gateway.access = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(open()).toHaveLength(1);

    gateway.profileId = null;
    await live.reconcile();
    expect(open()).toHaveLength(0);
    // Unbound: each compare still reads discovery, as the contract asks.
    const discovery = () =>
      gateway.requests.filter((request) => request.path === "/realtime").length;
    await vi.advanceTimersByTimeAsync(ORBIT_PROFILE_CHECK_MS);
    const before = discovery();
    await vi.advanceTimersByTimeAsync(3 * ORBIT_PROFILE_CHECK_MS);
    expect(discovery()).toBe(before + 3);
    live.dispose();
  });

  it("starts a new retry sequence for a new binding", async () => {
    using _clock = clock();
    const { gateway, live } = harness();
    gateway.access = false;
    gateway.refusal = { status: 500, code: "server.error" };
    await live.resume();
    // A fails twice: its next retry waits 10 s.
    await vi.advanceTimersByTimeAsync(5_000);
    const reads = gateway.requests.length;
    live.invalidate();
    await live.reconcile();
    expect(gateway.requests.length).toBe(reads + 1);
    // B's first failure retries after 5 s, not on A's schedule.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(gateway.requests.length).toBe(reads + 2);
    live.dispose();
  });

  it("starts a new retry sequence after Orbit is switched off and on", async () => {
    using _clock = clock();
    const scope = { value: "orbit" as string | null };
    const { gateway, live } = harness({ scope });
    gateway.access = false;
    gateway.refusal = { status: 500, code: "server.error" };
    await live.resume();
    await vi.advanceTimersByTimeAsync(5_000);
    scope.value = null;
    await live.reconcile();
    scope.value = "orbit";
    const reads = gateway.requests.length;
    await live.reconcile();
    expect(gateway.requests.length).toBe(reads + 1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(gateway.requests.length).toBe(reads + 2);
    live.dispose();
  });

  it("keeps the periodic check when the Gateway has no Reverb, and stops everything on pause", async () => {
    using _clock = clock();
    const { gateway, live, write, applied } = harness();
    gateway.reverb = false;
    await live.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(gateway.sockets).toHaveLength(0);
    write();
    await vi.advanceTimersByTimeAsync(ORBIT_PROFILE_CHECK_MS);
    expect(applied.at(-1)).toBe(6);

    live.pause();
    const requests = gateway.requests.length;
    write();
    await vi.advanceTimersByTimeAsync(10 * ORBIT_PROFILE_CHECK_MS);
    expect(gateway.requests).toHaveLength(requests);
    live.dispose();
  });
});
