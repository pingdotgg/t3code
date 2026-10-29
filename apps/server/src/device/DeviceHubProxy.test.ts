import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSessionId,
  LOCAL_DEVICE_HOST_ID,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import type * as DeviceHost from "./DeviceHost.ts";
import * as DeviceService from "./DeviceService.ts";
import * as DeviceHubProxy from "./DeviceHubProxy.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const fixture = (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  fail = false,
  authError?: EnvironmentAuth.ServerAuthCredentialError | EnvironmentAuth.ServerAuthInternalError,
  upstream?: DeviceHost.DeviceHostReady["upstream"],
) => {
  let finalized = 0;
  const requests: string[] = [];
  const headers: Array<Readonly<Record<string, string>>> = [];
  const client = HttpClient.make((request, _url, signal) =>
    Effect.gen(function* () {
      requests.push(request.url);
      headers.push(request.headers);
      signal.addEventListener("abort", () => {
        finalized++;
      });
      if (fail) return yield* Effect.die(new Error("upstream failed"));
      return HttpClientResponse.fromWeb(
        request,
        new Response("frame", { headers: { "set-cookie": "upstream=1" } }),
      );
    }),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    DeviceHubProxy.layer.pipe(
      Layer.provideMerge(
        Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
          authenticateWebSocketUpgrade: () =>
            authError
              ? Effect.fail(authError)
              : Effect.succeed({
                  sessionId: AuthSessionId.make("test"),
                  subject: "test",
                  method: "bearer-access-token",
                  scopes,
                }),
        } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(DeviceService.DeviceService, {
          currentReadiness: () =>
            Effect.succeed({
              hostId: LOCAL_DEVICE_HOST_ID,
              hub: { origin: "http://hub.test" },
              ...(upstream ? { upstream } : {}),
            }),
        } as DeviceService.DeviceService["Service"]),
      ),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, requests, headers, finalized: () => finalized };
};

describe("device hub proxy", () => {
  it("releases the upstream response after forwarding its body and strips tickets", async () => {
    const { handler, requests, finalized } = fixture([AuthOrchestrationReadScope]);
    const response = await handler(
      new Request("http://t3.test/api/device-hub/api/devices?wsTicket=secret"),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("frame");
    expect(requests).toEqual(["http://hub.test/api/devices"]);
    expect(finalized()).toBe(1);
  });

  it.each(["/vendor/serve-sim/helper/ws", "/vendor/serve-emu/ws"])(
    "rejects input socket %s for a read-only session",
    async (path) => {
      const { handler, requests } = fixture([AuthOrchestrationReadScope]);
      const response = await handler(
        new Request(`http://t3.test/api/device-hub${path}`, { headers: { upgrade: "websocket" } }),
      );
      expect(response.status).toBe(403);
      expect(requests).toEqual([]);
    },
  );

  it("requires operate scope for stream tuning", async () => {
    const readOnly = fixture([AuthOrchestrationReadScope]);
    const path = "http://t3.test/api/device-hub/vendor/serve-emu/api/stream-settings";
    expect((await readOnly.handler(new Request(path, { method: "POST" }))).status).toBe(403);
    const operator = fixture([AuthOrchestrationOperateScope]);
    const response = await operator.handler(new Request(path, { method: "POST" }));
    expect(response.status).toBe(200);
    await response.text();
  });

  it("reads Android fold state but requires operate scope to change it", async () => {
    const path = "http://t3.test/api/device-hub/vendor/serve-emu/api/fold?device=emulator-5554";
    const reader = fixture([AuthOrchestrationReadScope]);
    const read = await reader.handler(new Request(path));
    expect(read.status).toBe(200);
    await read.text();
    expect(reader.requests).toEqual([
      "http://hub.test/vendor/serve-emu/api/fold?device=emulator-5554",
    ]);
    const denied = await reader.handler(
      new Request(path, { method: "POST", body: '{"posture":"closed"}' }),
    );
    expect(denied.status).toBe(403);
    expect(reader.requests).toHaveLength(1);

    const operator = fixture([AuthOrchestrationOperateScope]);
    const changed = await operator.handler(
      new Request(path, { method: "POST", body: '{"posture":"closed"}' }),
    );
    expect(changed.status).toBe(200);
    await changed.text();
    expect(operator.requests).toEqual([
      "http://hub.test/vendor/serve-emu/api/fold?device=emulator-5554",
    ]);
  });

  it("presents fold changes from an HTTPS client as same-origin hub requests", async () => {
    const { handler, headers } = fixture([AuthOrchestrationOperateScope]);
    const response = await handler(
      new Request(
        "https://relay.test/api/device-hub/vendor/serve-emu/api/fold?device=emulator-5554",
        {
          method: "POST",
          headers: { origin: "https://relay.test", "x-forwarded-proto": "https" },
          body: '{"posture":"opened"}',
        },
      ),
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(headers).toHaveLength(1);
    expect(headers[0]?.origin).toBe("http://hub.test");
    expect(headers[0]).not.toHaveProperty("x-forwarded-proto");
  });

  it("lets a viewer negotiate a WebRTC stream with read scope", async () => {
    const { handler, requests, headers } = fixture([AuthOrchestrationReadScope]);
    const offer = await handler(
      new Request("http://t3.test/api/device-hub/vendor/serve-sim/helper/udid-1/webrtc/offer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"type":"offer"}',
      }),
    );
    expect(offer.status).toBe(200);
    await offer.text();
    expect(requests).toEqual(["http://hub.test/vendor/serve-sim/helper/udid-1/webrtc/offer"]);
    expect(headers[0]?.["content-type"]).toBe("application/json");
  });

  it("lets a viewer read Android stream capabilities and signal WebRTC with read scope", async () => {
    const { handler, requests } = fixture([AuthOrchestrationReadScope]);
    const hub = "http://t3.test/api/device-hub/vendor/serve-emu";
    const api = await handler(new Request(`${hub}/api?device=session-1`));
    expect(api.status).toBe(200);
    await api.text();
    for (const action of ["offer", "close"]) {
      const signal = await handler(
        new Request(`${hub}/webrtc/${action}?device=session-1`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"sessionId":"viewer"}',
        }),
      );
      expect(signal.status).toBe(200);
      await signal.text();
    }
    expect(requests).toEqual([
      "http://hub.test/vendor/serve-emu/api?device=session-1",
      "http://hub.test/vendor/serve-emu/webrtc/offer?device=session-1",
      "http://hub.test/vendor/serve-emu/webrtc/close?device=session-1",
    ]);
    expect((await handler(new Request(`${hub}/api`, { method: "POST" }))).status).toBe(405);
    expect((await handler(new Request(`${hub}/webrtc/offer`))).status).toBe(405);
  });

  it("sends requests a host routes itself to its upstream with its credentials", async () => {
    const { handler, requests, headers } = fixture(
      [AuthOrchestrationReadScope],
      false,
      undefined,
      (hubPath, search) =>
        Effect.succeed(
          hubPath === "/vendor/serve-sim/api"
            ? {
                url: `https://session.test${hubPath.slice("/vendor/serve-sim".length)}?${search}`,
                headers: { authorization: "Bearer session-token" },
                protocols: [],
              }
            : null,
        ),
    );
    const routed = await handler(
      new Request("http://t3.test/api/device-hub/vendor/serve-sim/api?device=udid-1&hostId=eas", {
        headers: { authorization: "Bearer environment-token" },
      }),
    );
    expect(routed.status).toBe(200);
    expect(routed.headers.get("set-cookie")).toBeNull();
    await routed.text();
    expect(requests).toEqual(["https://session.test/api?device=udid-1"]);
    expect(headers[0]?.authorization).toBe("Bearer session-token");
    const unrouted = await handler(
      new Request("http://t3.test/api/device-hub/vendor/serve-sim/helper/udid-2/stream.mjpeg"),
    );
    expect(unrouted.status).toBe(404);
    expect(requests).toHaveLength(1);
  });

  it("never forwards the vendor shell endpoint", async () => {
    const { handler, requests } = fixture([AuthOrchestrationOperateScope]);
    expect(
      (
        await handler(
          new Request("http://t3.test/api/device-hub/vendor/serve-sim/exec", { method: "POST" }),
        )
      ).status,
    ).toBe(404);
    expect(requests).toEqual([]);
  });
});

it.each([
  [new EnvironmentAuth.ServerAuthMissingCredentialError({}), 401],
  [
    new EnvironmentAuth.ServerAuthSessionCredentialValidationError({
      cause: new Error("private credential diagnostic"),
    }),
    500,
  ],
] as const)("translates authentication failure to HTTP %s", async (error, status) => {
  const { handler, requests } = fixture([], false, error);
  const response = await handler(new Request("http://t3.test/api/device-hub/api/devices"));
  expect(response.status).toBe(status);
  expect(await response.text()).not.toContain("private credential diagnostic");
  expect(requests).toEqual([]);
});

it("rejects unsupported Duo routes", async () => {
  const { handler, requests } = fixture([AuthOrchestrationReadScope]);
  const response = await handler(
    new Request("http://t3.test/api/device-hub/vendor/serve-sim/helper/duo/panel/1/webrtc/offer"),
  );
  expect(response.status).toBe(404);
  expect(requests).toEqual([]);
});
