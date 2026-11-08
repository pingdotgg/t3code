import { expect, it } from "@effect/vitest";
import { createBoatApiClient } from "@t3tools/boat";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { createBoatCloudSandboxDriver } from "./boatDriver.ts";
import { cloudSandboxCapabilities } from "../../driver.ts";

it.effect("resolves the provider endpoint and authenticated host key without fallback hosts", () =>
  Effect.gen(function* () {
    const httpClient = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            machineIp: "1.2.3.4",
            sshEndpoint: "gateway.boat.dev:22001",
            sshUser: "user",
            hostKey: "ssh-ed25519 AAAA",
          }),
        ),
      ),
    );
    const driver = createBoatCloudSandboxDriver(
      createBoatApiClient({ apiKey: "boat_test", httpClient }),
    );
    const result = yield* driver.registerSshKey("bx_23456789", "ssh-ed25519 PUBLIC");
    expect(result.target).toEqual({
      alias: "boat-bx_23456789",
      hostname: "gateway.boat.dev",
      port: 22001,
      username: "user",
    });
    expect(result.hostKey).toBe("ssh-ed25519 AAAA");
    expect(cloudSandboxCapabilities(driver)).toEqual({
      diskForking: true,
      desktopStreaming: true,
      browserStreaming: true,
      autoStopKeepalive: true,
      publicPortHosting: true,
      protectedPortHosting: true,
      recording: true,
      usage: true,
      resizeMode: "restart",
      hotResize: false,
      rootAccess: true,
    });
  }),
);

it.effect("rejects invalid provider sizing before making a request", () =>
  Effect.gen(function* () {
    let requests = 0;
    const httpClient = HttpClient.make(() => {
      requests++;
      return Effect.die(new Error("Unexpected HTTP request"));
    });
    const driver = createBoatCloudSandboxDriver(
      createBoatApiClient({ apiKey: "boat_test", httpClient }),
    );
    const result = yield* driver.create({ name: "dev", size: "invalid" }).pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    const { forking, resizing } = driver;
    if (!forking || !resizing) throw new Error("Boat fork and resize capabilities missing");
    expect(
      (yield* forking.forkSandbox("bx_23456789", { size: "invalid" }).pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect((yield* resizing.resize("bx_23456789", "invalid").pipe(Effect.result))._tag).toBe(
      "Failure",
    );
    expect(requests).toBe(0);
  }),
);

it.effect("derives list rate from provider usage and rejects usage for another sandbox", () =>
  Effect.gen(function* () {
    let sandboxId = "bx_23456789";
    const httpClient = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            ok: true,
            sandboxId,
            sandboxType: "small",
            billingMultiplier: 0.5,
            seconds: 1800,
            dollars: 0.018,
            secondsPerDollar: 100000,
            running: true,
            since: "2026-11-06T00:00:00Z",
            until: "2026-11-06T01:00:00Z",
          }),
        ),
      ),
    );
    const driver = createBoatCloudSandboxDriver(
      createBoatApiClient({ apiKey: "boat_test", httpClient }),
    );
    const usage = driver.usage;
    if (!usage) throw new Error("Boat usage capability missing");
    expect((yield* usage.getUsage(sandboxId)).listRateUsdPerHour).toBe(0.018);
    sandboxId = "bx_abcdef23";
    expect((yield* usage.getUsage("bx_23456789").pipe(Effect.result))._tag).toBe("Failure");
  }),
);

it.effect("resizes through stop and resume and waits for a fresh snapshot", () =>
  Effect.gen(function* () {
    const requests: string[] = [];
    let resized = false;
    const httpClient = HttpClient.make((request) => {
      requests.push(request.method + " " + new URL(request.url).pathname);
      if (request.url.endsWith("/saved-snapshots/fresh"))
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              ok: true,
              snapshot: { name: "fresh", status: "ready", sourceSandboxId: "bx_23456789" },
            }),
          ),
        );
      if (request.url.endsWith("/resume")) resized = true;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            ok: true,
            sandbox: {
              id: "bx_23456789",
              name: "dev",
              state: resized ? "idle" : "archived",
              type: resized ? "small" : "default",
            },
          }),
        ),
      );
    });
    const driver = createBoatCloudSandboxDriver(
      createBoatApiClient({ apiKey: "boat_test", httpClient }),
    );
    if (!driver.resizing || !driver.snapshots)
      throw new Error("Required Boat capabilities missing");
    expect((yield* driver.resizing.resize("bx_23456789", "small")).size).toBe("small");
    expect(requests).toEqual([
      "POST /api/v1/sandboxes/bx_23456789/stop",
      "GET /api/v1/sandboxes/bx_23456789",
      "POST /api/v1/sandboxes/bx_23456789/resume",
      "GET /api/v1/sandboxes/bx_23456789",
      "GET /api/v1/sandboxes/bx_23456789",
    ]);
    expect((yield* driver.snapshots.waitReady("fresh")).state).toBe("ready");
  }),
);
