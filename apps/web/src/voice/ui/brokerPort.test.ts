import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentId, VoiceSessionId } from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";

import {
  brokerStatusToToolError,
  createFetchVoiceBrokerPort,
  selectVoiceBrokerEnvironment,
  type VoiceBrokerCandidate,
} from "./brokerPort";

const PREPARED: PreparedConnection = {
  environmentId: "env-1" as EnvironmentId,
  label: "Test env",
  httpBaseUrl: "https://env1.example.test",
  socketUrl: "wss://env1.example.test/ws",
  httpAuthorization: { _tag: "Bearer", token: "bearer-token" },
  target: { _tag: "PrimaryConnectionTarget" } as unknown as PreparedConnection["target"],
};

const candidate = (overrides?: Partial<VoiceBrokerCandidate>): VoiceBrokerCandidate => ({
  environmentId: "env-1" as EnvironmentId,
  label: "Env 1",
  connected: true,
  isPrimary: true,
  voiceLiveCapable: true,
  scopes: ["orchestration:operate"],
  ...overrides,
});

describe("voice broker environment selection", () => {
  it("prefers the primary environment when it is connected, capable, and holds operate scope", () => {
    const selection = selectVoiceBrokerEnvironment([
      candidate({ environmentId: "env-2" as EnvironmentId, isPrimary: false }),
      candidate({ environmentId: "env-1" as EnvironmentId, isPrimary: true }),
    ]);
    expect(selection).toEqual({ status: "ok", environmentId: "env-1", label: "Env 1" });
  });

  it("falls back to the first connected capable non-primary environment", () => {
    const selection = selectVoiceBrokerEnvironment([
      candidate({ isPrimary: true, connected: false }),
      candidate({ environmentId: "env-2" as EnvironmentId, isPrimary: false }),
    ]);
    expect(selection).toEqual({ status: "ok", environmentId: "env-2", label: "Env 1" });
  });

  it("skips environments without the capability or without operate scope", () => {
    const selection = selectVoiceBrokerEnvironment([
      candidate({ voiceLiveCapable: false }),
      candidate({ scopes: ["orchestration:read"] }),
      candidate({ connected: false }),
    ]);
    expect(selection.status).toBe("unavailable");
    if (selection.status === "unavailable") {
      expect(selection.reason).toContain("voice");
    }
  });
});

describe("fetch voice broker port", () => {
  it.each(["http://localhost:5924/", "https://remote.example.test/"])(
    "uses canonical broker paths with a normalized base URL %s",
    async (httpBaseUrl) => {
      const requests: Array<Request> = [];
      const port = createFetchVoiceBrokerPort({
        prepared: { ...PREPARED, httpBaseUrl },
        signer: Option.none(),
        fetchImpl: async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          const path = new URL(request.url).pathname;
          if (path === "/api/voice/sessions") {
            return Response.json({ sessionId: "live_sess_1", sdp: "answer-sdp" });
          }
          if (path === "/api/voice/sessions/close") {
            return Response.json({ closed: true });
          }
          return new Response(null, { status: 404 });
        },
      });

      await expect(
        port.mintSession({ transport: { type: "webrtc", sdp: "offer" } }),
      ).resolves.toMatchObject({ sessionId: "live_sess_1" });
      await expect(
        port.closeSession({ sessionId: "live_sess_1" as VoiceSessionId }),
      ).resolves.toEqual({ closed: true });
      expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
        "/api/voice/sessions",
        "/api/voice/sessions/close",
      ]);
    },
  );

  it("mints a session over the broker route with the bearer credential", async () => {
    const requests: Array<Request> = [];
    const port = createFetchVoiceBrokerPort({
      prepared: PREPARED,
      signer: Option.none(),
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return new Response(JSON.stringify({ sessionId: "live_sess_1", sdp: "answer-sdp" }), {
          status: 200,
        });
      }) as unknown as typeof fetch,
    });

    const created = await port.mintSession({
      transport: { type: "webrtc", sdp: "offer-sdp" },
    });

    expect(created.sessionId).toBe("live_sess_1");
    expect(created.sdp).toBe("answer-sdp");
    const request = requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("https://env1.example.test/api/voice/sessions");
    expect(request?.headers.get("authorization")).toBe("Bearer bearer-token");
    expect(request?.credentials).toBe("same-origin");
    const body = (await request?.json()) as { transport?: { type?: string; sdp?: string } };
    expect(body.transport).toEqual({ type: "webrtc", sdp: "offer-sdp" });
  });

  it("sends credentialed cookies for primary connections without a token", async () => {
    const requests: Array<Request> = [];
    const port = createFetchVoiceBrokerPort({
      prepared: { ...PREPARED, httpAuthorization: null },
      signer: Option.none(),
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return new Response(JSON.stringify({ sessionId: "s", sdp: "d" }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    await port.mintSession({ transport: { type: "webrtc", sdp: "offer-sdp" } });

    expect(requests[0]?.credentials).toBe("include");
  });

  it("closes the session through the broker close route", async () => {
    const requests: Array<Request> = [];
    const port = createFetchVoiceBrokerPort({
      prepared: PREPARED,
      signer: Option.none(),
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return new Response(JSON.stringify({ closed: true }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    const result = await port.closeSession({
      sessionId: "live_sess_1" as VoiceSessionId,
    });

    expect(result.closed).toBe(true);
    expect(requests[0]?.url).toBe("https://env1.example.test/api/voice/sessions/close");
  });

  it.each([
    [401, "auth_invalid"],
    [403, "insufficient_scope"],
    [400, "invalid_request"],
    [404, "invalid_request"],
    [502, "environment_unreachable"],
  ] as const)("maps broker status %s to the frozen %s code", async (status, code) => {
    const port = createFetchVoiceBrokerPort({
      prepared: PREPARED,
      signer: Option.none(),
      fetchImpl: (async () => new Response("nope", { status })) as unknown as typeof fetch,
    });

    await expect(
      port.mintSession({ transport: { type: "webrtc", sdp: "offer" } }),
    ).rejects.toMatchObject({ code });
  });

  it("maps a shapeless success response to environment_unreachable instead of guessing", async () => {
    const port = createFetchVoiceBrokerPort({
      prepared: PREPARED,
      signer: Option.none(),
      fetchImpl: (async () =>
        new Response(JSON.stringify({ unexpected: true }), {
          status: 200,
        })) as unknown as typeof fetch,
    });

    await expect(
      port.mintSession({ transport: { type: "webrtc", sdp: "offer" } }),
    ).rejects.toMatchObject({ code: "environment_unreachable" });
  });

  it("maps a network failure to environment_unreachable", async () => {
    const port = createFetchVoiceBrokerPort({
      prepared: PREPARED,
      signer: Option.none(),
      fetchImpl: (async () => {
        throw new Error("connection refused");
      }) as unknown as typeof fetch,
    });

    await expect(
      port.mintSession({ transport: { type: "webrtc", sdp: "offer" } }),
    ).rejects.toMatchObject({ code: "environment_unreachable" });
  });
});

describe("broker status mapping", () => {
  it("keeps the body detail in the message", () => {
    const error = brokerStatusToToolError(403, "missing scope");
    expect(error.code).toBe("insufficient_scope");
    expect(error.message).toContain("missing scope");
  });
});
