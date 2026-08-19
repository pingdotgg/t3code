import { describe, expect, it } from "vite-plus/test";
import * as Result from "effect/Result";

import {
  decodeRelayTransportControlFrame,
  decodeRelayTransportFrame,
  encodeRelayTransportControlFrame,
  encodeRelayTransportFrame,
  encodeRelayTransportMessageFrames,
  RELAY_TRANSPORT_MAX_FRAME_PAYLOAD_BYTES,
  RELAY_TRANSPORT_PROTOCOL_VERSION,
  RelayTransportFrameKind,
} from "@t3tools/contracts/relayTransport";

import {
  T3RelayConnectorSession,
  type RelayConnectorSocket,
  type T3RelayConnectorLifecycleEvent,
} from "./T3RelayConnector.ts";

class TestSocket implements RelayConnectorSocket {
  binaryType = "blob";
  readyState = 0;
  readonly sent: Array<string | ArrayBuffer | Uint8Array> = [];
  readonly closed: Array<{ code?: number; reason?: string }> = [];
  readonly #listeners = new Map<string, Array<(event?: never) => void>>();

  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "close",
    listener: (event: { readonly code: number; readonly reason: string }) => void,
  ): void;
  addEventListener(
    type: "message",
    listener: (event: { readonly data: string | ArrayBuffer | Uint8Array }) => void,
  ): void;
  addEventListener(
    type: "open" | "close" | "message",
    listener:
      | (() => void)
      | ((event: { readonly code: number; readonly reason: string }) => void)
      | ((event: { readonly data: string | ArrayBuffer | Uint8Array }) => void),
  ): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener as (event?: never) => void);
    this.#listeners.set(type, listeners);
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed.push({
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    });
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    for (const listener of this.#listeners.get("open") ?? []) listener();
  }

  message(data: string | ArrayBuffer | Uint8Array): void {
    for (const listener of this.#listeners.get("message") ?? []) listener({ data } as never);
  }

  peerClose(code: number, reason: string): void {
    this.readyState = 3;
    for (const listener of this.#listeners.get("close") ?? []) {
      listener({ code, reason } as never);
    }
  }
}

function decodedControl(value: string | ArrayBuffer | Uint8Array) {
  const frame = decodeRelayTransportFrame(value as Uint8Array);
  expect(Result.isSuccess(frame)).toBe(true);
  if (Result.isFailure(frame)) throw frame.failure;
  const control = decodeRelayTransportControlFrame(frame.success);
  expect(Result.isSuccess(control)).toBe(true);
  if (Result.isFailure(control)) throw control.failure;
  return control.success;
}

const connectorTicketResponse = () =>
  Promise.resolve(
    Response.json(
      {
        ticket: "single-use-ticket-123",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      { status: 201 },
    ),
  );

const waitForConnector = () => new Promise<void>((resolve) => setImmediate(resolve));

function readyConnector(socket: TestSocket): void {
  if (socket.readyState !== 1) socket.open();
  socket.message(
    encodeRelayTransportControlFrame(0, {
      type: "connector_ready",
      protocolVersion: RELAY_TRANSPORT_PROTOCOL_VERSION,
    }),
  );
}

describe("T3RelayConnectorSession", () => {
  it("cancels an in-flight ticket request when stopped", async () => {
    let signal: AbortSignal | undefined;
    const session = new T3RelayConnectorSession(
      {
        connectorUrl: "wss://endpoint.edge.test/.well-known/t3-relay/connect",
        connectorToken: "token",
        originUrl: "http://127.0.0.1:7331/",
      },
      () => new TestSocket(),
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
        }),
    );

    session.start();
    expect(signal?.aborted).toBe(false);
    session.close();
    expect(signal?.aborted).toBe(true);
    await Promise.resolve();
  });

  it("rejects non-loopback origins and insecure connector URLs", () => {
    expect(
      () =>
        new T3RelayConnectorSession({
          connectorUrl: "ws://endpoint.edge.test/.well-known/t3-relay/connect",
          connectorToken: "token",
          originUrl: "http://127.0.0.1:7331",
        }),
    ).toThrow(/secure connector endpoint/u);
    expect(
      () =>
        new T3RelayConnectorSession({
          connectorUrl: "wss://endpoint.edge.test/.well-known/t3-relay/connect",
          connectorToken: "token",
          originUrl: "http://internal.example.test:7331",
        }),
    ).toThrow(/loopback HTTP endpoint/u);
  });

  it("exchanges the long-lived credential for a single-use connection ticket", async () => {
    const sockets: Array<{ url: string; socket: TestSocket }> = [];
    const ticketRequests: Array<Request> = [];
    const session = new T3RelayConnectorSession(
      {
        connectorUrl: "wss://endpoint.edge.test/.well-known/t3-relay/connect",
        connectorToken: "secret token",
        originUrl: "http://127.0.0.1:7331/",
      },
      (url) => {
        const socket = new TestSocket();
        sockets.push({ url, socket });
        return socket;
      },
      async (input, init) => {
        ticketRequests.push(
          input instanceof Request ? new Request(input, init) : new Request(input.toString(), init),
        );
        return connectorTicketResponse();
      },
    );

    session.start();
    await waitForConnector();
    expect(ticketRequests).toHaveLength(1);
    expect(ticketRequests[0]!.url).toBe("https://endpoint.edge.test/.well-known/t3-relay/connect");
    expect(ticketRequests[0]!.headers.get("authorization")).toBe("Bearer secret token");
    expect(sockets[0]?.url).toBe(
      "wss://endpoint.edge.test/.well-known/t3-relay/connect?ticket=single-use-ticket-123",
    );
    readyConnector(sockets[0]!.socket);
    sockets[0]!.socket.message(
      encodeRelayTransportControlFrame(9, {
        type: "websocket_open",
        url: "wss://endpoint.edge.test/ws?client=mobile",
        headers: [],
        protocols: [],
      }),
    );

    expect(sockets[1]?.url).toBe("ws://127.0.0.1:7331/ws?client=mobile");
    sockets[1]!.socket.open();
    expect(decodedControl(sockets[0]!.socket.sent[0]!)).toEqual({ type: "websocket_accept" });
  });

  it("reports connector lifecycle without letting observers break recovery", async () => {
    const events: Array<string> = [];
    const socket = new TestSocket();
    const session = new T3RelayConnectorSession(
      {
        connectorUrl: "wss://endpoint.edge.test/.well-known/t3-relay/connect",
        connectorToken: "token",
        originUrl: "http://127.0.0.1:7331/",
      },
      () => socket,
      connectorTicketResponse,
      (event) => {
        events.push(event.type);
        if (event.type === "connecting") throw new Error("observer failed");
      },
    );

    session.start();
    await waitForConnector();
    socket.open();
    expect(events).toEqual(["connecting"]);
    readyConnector(socket);
    expect(events).toEqual(["connecting", "connected"]);
    session.close();
  });

  it("ignores traffic before protocol readiness and from a stale edge socket", async () => {
    const sockets: Array<TestSocket> = [];
    const session = new T3RelayConnectorSession(
      {
        connectorUrl: "wss://endpoint.edge.test/.well-known/t3-relay/connect",
        connectorToken: "token",
        originUrl: "http://127.0.0.1:7331/",
      },
      () => {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
      connectorTicketResponse,
    );

    session.start();
    await waitForConnector();
    sockets[0]!.open();
    const openLocal = encodeRelayTransportControlFrame(3, {
      type: "websocket_open",
      url: "wss://endpoint.edge.test/ws",
      headers: [],
      protocols: [],
    });
    sockets[0]!.message(openLocal);
    expect(sockets).toHaveLength(1);

    readyConnector(sockets[0]!);
    sockets[0]!.peerClose(1006, "edge lost");
    sockets[0]!.message(openLocal);
    expect(sockets).toHaveLength(1);
    session.close();
  });

  it("reports retry categories without exposing connector credentials", async () => {
    const events: Array<T3RelayConnectorLifecycleEvent> = [];
    const session = new T3RelayConnectorSession(
      {
        connectorUrl: "wss://endpoint.edge.test/.well-known/t3-relay/connect",
        connectorToken: "credential-that-must-not-be-logged",
        originUrl: "http://127.0.0.1:7331/",
      },
      () => new TestSocket(),
      () => Promise.resolve(new Response("unauthorized", { status: 401 })),
      (event) => events.push(event),
    );

    session.start();
    await waitForConnector();
    expect(events).toEqual([
      { type: "connecting" },
      expect.objectContaining({ type: "retry_scheduled", reason: "ticket_http_401" }),
    ]);
    expect(JSON.stringify(events)).not.toContain("credential-that-must-not-be-logged");
    session.close();
  });

  it("forwards text and binary frames in both directions", async () => {
    const sockets: Array<TestSocket> = [];
    const session = new T3RelayConnectorSession(
      {
        connectorUrl: "wss://endpoint.edge.test/.well-known/t3-relay/connect",
        connectorToken: "token",
        originUrl: "http://localhost:7331/",
      },
      () => {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
      connectorTicketResponse,
    );
    session.start();
    await waitForConnector();
    readyConnector(sockets[0]!);
    sockets[0]!.message(
      encodeRelayTransportControlFrame(4, {
        type: "websocket_open",
        url: "wss://endpoint.edge.test/ws",
        headers: [],
        protocols: [],
      }),
    );
    sockets[1]!.open();
    sockets[0]!.message(
      encodeRelayTransportFrame({
        kind: RelayTransportFrameKind.websocketText,
        streamId: 4,
        endOfMessage: true,
        payload: new TextEncoder().encode("from edge"),
      }),
    );
    sockets[1]!.message(Uint8Array.of(1, 2, 3));

    expect(sockets[1]!.sent).toContain("from edge");
    const response = decodeRelayTransportFrame(sockets[0]!.sent.at(-1)! as Uint8Array);
    expect(Result.isSuccess(response) && response.success.kind).toBe(
      RelayTransportFrameKind.websocketBinary,
    );
    expect(Result.isSuccess(response) && [...response.success.payload]).toEqual([1, 2, 3]);
  });

  it("preserves local WebSocket close details without echoing edge-initiated closes", async () => {
    const sockets: Array<TestSocket> = [];
    const session = new T3RelayConnectorSession(
      {
        connectorUrl: "wss://endpoint.edge.test/.well-known/t3-relay/connect",
        connectorToken: "token",
        originUrl: "http://localhost:7331/",
      },
      () => {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
      connectorTicketResponse,
    );
    session.start();
    await waitForConnector();
    readyConnector(sockets[0]!);
    sockets[0]!.message(
      encodeRelayTransportControlFrame(6, {
        type: "websocket_open",
        url: "wss://endpoint.edge.test/ws",
        headers: [],
        protocols: [],
      }),
    );
    sockets[1]!.open();
    sockets[1]!.peerClose(4003, "Local authorization expired");
    expect(decodedControl(sockets[0]!.sent.at(-1)!)).toEqual({
      type: "websocket_close",
      code: 4003,
      reason: "Local authorization expired",
    });

    sockets[0]!.message(
      encodeRelayTransportControlFrame(8, {
        type: "websocket_open",
        url: "wss://endpoint.edge.test/ws",
        headers: [],
        protocols: [],
      }),
    );
    sockets[2]!.open();
    sockets[2]!.peerClose(1006, "Abnormal local close");
    expect(decodedControl(sockets[0]!.sent.at(-1)!)).toEqual({
      type: "websocket_close",
      code: 1011,
      reason: "Abnormal local close",
    });

    sockets[0]!.message(
      encodeRelayTransportControlFrame(7, {
        type: "websocket_open",
        url: "wss://endpoint.edge.test/ws",
        headers: [],
        protocols: [],
      }),
    );
    sockets[3]!.open();
    const sentBeforeClose = sockets[0]!.sent.length;
    sockets[0]!.message(
      encodeRelayTransportControlFrame(7, {
        type: "websocket_close",
        code: 1001,
        reason: "Public client left",
      }),
    );
    sockets[3]!.peerClose(1001, "Public client left");
    expect(sockets[0]!.sent).toHaveLength(sentBeforeClose);
  });

  it("fragments and reassembles WebSocket messages larger than one transport frame", async () => {
    const sockets: Array<TestSocket> = [];
    const session = new T3RelayConnectorSession(
      {
        connectorUrl: "wss://endpoint.edge.test/.well-known/t3-relay/connect",
        connectorToken: "token",
        originUrl: "http://localhost:7331/",
      },
      () => {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
      connectorTicketResponse,
    );
    session.start();
    await waitForConnector();
    readyConnector(sockets[0]!);
    sockets[0]!.message(
      encodeRelayTransportControlFrame(5, {
        type: "websocket_open",
        url: "wss://endpoint.edge.test/ws",
        headers: [],
        protocols: [],
      }),
    );
    sockets[1]!.open();
    const payload = new Uint8Array(RELAY_TRANSPORT_MAX_FRAME_PAYLOAD_BYTES + 11);
    payload.fill(7);
    for (const frame of encodeRelayTransportMessageFrames({
      kind: RelayTransportFrameKind.websocketBinary,
      streamId: 5,
      payload,
    })) {
      sockets[0]!.message(frame);
    }

    expect(sockets[1]!.sent).toHaveLength(1);
    expect(sockets[1]!.sent[0]).toEqual(payload);

    sockets[1]!.message(payload);
    const outbound = sockets[0]!.sent
      .map((value) => decodeRelayTransportFrame(value as Uint8Array))
      .filter(
        (result) =>
          Result.isSuccess(result) &&
          result.success.kind === RelayTransportFrameKind.websocketBinary,
      );
    expect(outbound).toHaveLength(2);
    expect(Result.isSuccess(outbound[0]!) && outbound[0].success.endOfMessage).toBe(false);
    expect(Result.isSuccess(outbound[1]!) && outbound[1].success.endOfMessage).toBe(true);
  });

  it("proxies HTTP requests to the configured loopback origin", async () => {
    const sockets: Array<TestSocket> = [];
    const requests: Array<Request> = [];
    const session = new T3RelayConnectorSession(
      {
        connectorUrl: "wss://endpoint.edge.test/.well-known/t3-relay/connect",
        connectorToken: "token",
        originUrl: "http://127.0.0.1:7331/",
      },
      () => {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
      async (input, init) => {
        const request =
          input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
        if (new URL(request.url).pathname === "/.well-known/t3-relay/connect") {
          return connectorTicketResponse();
        }
        requests.push(request);
        const responseHeaders = new Headers({ "content-type": "text/plain" });
        responseHeaders.append("set-cookie", "session=one; Path=/; HttpOnly");
        responseHeaders.append("set-cookie", "preference=compact; Path=/");
        return new Response("local response", {
          status: 201,
          headers: responseHeaders,
        });
      },
    );
    session.start();
    await waitForConnector();
    readyConnector(sockets[0]!);
    sockets[0]!.message(
      encodeRelayTransportControlFrame(12, {
        type: "http_request_start",
        method: "POST",
        url: "https://endpoint.edge.test/oauth/token?attempt=1",
        headers: [
          ["content-type", "text/plain"],
          ["host", "endpoint.edge.test"],
        ],
      }),
    );
    sockets[0]!.message(
      encodeRelayTransportFrame({
        kind: RelayTransportFrameKind.httpRequestBody,
        streamId: 12,
        endOfMessage: true,
        payload: new TextEncoder().encode("request body"),
      }),
    );
    sockets[0]!.message(encodeRelayTransportControlFrame(12, { type: "http_request_end" }));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("http://127.0.0.1:7331/oauth/token?attempt=1");
    expect(requests[0]!.headers.get("host")).toBeNull();
    expect(await requests[0]!.text()).toBe("request body");
    expect(
      sockets[0]!.sent.some((value) => {
        const frame = decodeRelayTransportFrame(value as Uint8Array);
        return (
          Result.isSuccess(frame) && frame.success.kind === RelayTransportFrameKind.httpResponseBody
        );
      }),
    ).toBe(false);
    sockets[0]!.message(
      encodeRelayTransportControlFrame(12, {
        type: "window_update",
        creditBytes: 64 * 1024,
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const controls = sockets[0]!.sent
      .filter((value) => {
        const frame = decodeRelayTransportFrame(value as Uint8Array);
        return Result.isSuccess(frame) && frame.success.kind === RelayTransportFrameKind.control;
      })
      .map((value) => decodedControl(value))
      .filter((message) => message.type !== "connector_ready");
    expect(controls[0]).toMatchObject({ type: "http_response_start", status: 201 });
    expect(controls[0]).toMatchObject({
      headers: expect.arrayContaining([
        ["set-cookie", "session=one; Path=/; HttpOnly"],
        ["set-cookie", "preference=compact; Path=/"],
      ]),
    });
    expect(controls.at(-1)).toEqual({ type: "http_response_end" });
  });
});
