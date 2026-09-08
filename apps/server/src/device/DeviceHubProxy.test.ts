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
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/unstable/http";
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { DeviceService } from "./DeviceService.ts";
import { deviceHubProxyRouteLayer } from "./DeviceHubProxy.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const fixture = (scopes: ReadonlyArray<AuthEnvironmentScope>, fail = false) => {
  let finalized = 0;
  const requests: string[] = [];
  const client = HttpClient.make((request, _url, signal) =>
    Effect.gen(function* () {
      requests.push(request.url);
      signal.addEventListener("abort", () => {
        finalized++;
      });
      if (fail) return yield* Effect.die(new Error("upstream failed"));
      return HttpClientResponse.fromWeb(request, new Response("frame"));
    }),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    deviceHubProxyRouteLayer.pipe(
      Layer.provideMerge(
        Layer.succeed(EnvironmentAuth, {
          authenticateWebSocketUpgrade: () =>
            Effect.succeed({
              sessionId: AuthSessionId.make("test"),
              subject: "test",
              method: "bearer-access-token",
              scopes,
            }),
        } as unknown as EnvironmentAuth["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(DeviceService, {
          currentReadiness: () =>
            Effect.succeed({ hostId: LOCAL_DEVICE_HOST_ID, hub: { origin: "http://hub.test" } }),
        } as DeviceService["Service"]),
      ),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, requests, finalized: () => finalized };
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

  it("releases resources when upstream acquisition fails", async () => {
    const { handler, finalized } = fixture([AuthOrchestrationReadScope], true);
    const response = await handler(new Request("http://t3.test/api/device-hub/api/devices"));
    expect(response.status).toBe(500);
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
