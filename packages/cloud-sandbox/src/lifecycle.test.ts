import { expect, it } from "@effect/vitest";
import { createBoatApiClient } from "@t3tools/boat";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { createBoatCloudSandboxDriver } from "./drivers/boat/boatDriver.ts";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { maintainActiveSandbox, ensureCloudSandboxReady } from "./lifecycle.ts";

it.effect("resumes archived machines and refuses resume when disabled", () =>
  Effect.gen(function* () {
    let state = "archived";
    let resumes = 0;
    const httpClient = HttpClient.make((request) => {
      if (request.url.endsWith("/resume")) {
        resumes++;
        state = "idle";
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ ok: true, sandbox: { id: "bx_23456789", name: "dev", state } }),
        ),
      );
    });
    const driver = createBoatCloudSandboxDriver(
      createBoatApiClient({ apiKey: "boat_test", httpClient }),
    );
    const blocked = yield* ensureCloudSandboxReady(driver, "bx_23456789", false).pipe(
      Effect.result,
    );
    expect(blocked._tag).toBe("Failure");
    expect(resumes).toBe(0);
    expect((yield* ensureCloudSandboxReady(driver, "bx_23456789")).state).toBe("ready");
    expect(resumes).toBe(1);
  }),
);

it.effect("resumes a machine that finishes stopping while it is polled", () =>
  Effect.gen(function* () {
    const states = ["archiving", "archiving", "archived"];
    let resumes = 0;
    const httpClient = HttpClient.make((request) => {
      if (request.url.endsWith("/resume")) {
        resumes++;
        states.push("idle");
      }
      const state = states.length > 1 ? states.shift() : states[0];
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ ok: true, sandbox: { id: "bx_23456789", name: "dev", state } }),
        ),
      );
    });
    const driver = createBoatCloudSandboxDriver(
      createBoatApiClient({ apiKey: "boat_test", httpClient }),
    );
    const ready = yield* ensureCloudSandboxReady(driver, "bx_23456789").pipe(Effect.forkChild);
    yield* TestClock.adjust("10 seconds");
    expect((yield* Fiber.join(ready)).state).toBe("ready");
    expect(resumes).toBe(1);
  }),
);

it.effect(
  "extends only during active work and releases the host-owned worker on interruption",
  () =>
    Effect.gen(function* () {
      const probes = yield* Queue.unbounded<boolean>();
      const extensions = yield* Queue.unbounded<number>();
      const active = yield* Ref.make(false);
      const isActive = Ref.get(active).pipe(Effect.tap((value) => Queue.offer(probes, value)));
      const sandbox = {
        sandboxId: "bx_23456789",
        driverKind: "boat",
        name: "dev",
        state: "ready",
        size: "default",
        autoStopDeadline: null,
        createdAt: "",
      } as const;
      const worker = yield* Effect.forkChild(
        maintainActiveSandbox(
          {
            extendAutoStop: (_id, hours) => Queue.offer(extensions, hours).pipe(Effect.as(sandbox)),
          },
          sandbox.sandboxId,
          isActive,
        ),
      );
      expect(yield* Queue.take(probes)).toBe(false);
      yield* Ref.set(active, true);
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.take(probes)).toBe(true);
      expect(yield* Queue.take(extensions)).toBe(1);
      yield* Ref.set(active, false);
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.take(probes)).toBe(false);
      expect(yield* Queue.size(extensions)).toBe(0);
      yield* Fiber.interrupt(worker);
    }),
);

it.effect(
  "scales keepalive renewal cadence for short TTLs and preserves configured multi-hour TTLs",
  () =>
    Effect.gen(function* () {
      const sandbox = {
        sandboxId: "bx_23456789",
        driverKind: "boat",
        name: "dev",
        state: "ready",
        size: "default",
        autoStopDeadline: null,
        createdAt: "",
      } as const;

      const shortExtensions = yield* Queue.unbounded<number>();
      const shortWorker = yield* Effect.forkChild(
        maintainActiveSandbox(
          {
            extendAutoStop: (_id, hours) =>
              Queue.offer(shortExtensions, hours).pipe(Effect.as(sandbox)),
          },
          sandbox.sandboxId,
          Effect.succeed(true),
          { autoStopMinutes: 10 },
        ),
      );
      expect(yield* Queue.take(shortExtensions)).toBe(1);
      yield* TestClock.adjust("5 minutes");
      yield* Effect.yieldNow;
      expect(yield* Queue.size(shortExtensions)).toBe(1);
      expect(yield* Queue.take(shortExtensions)).toBe(1);
      yield* Fiber.interrupt(shortWorker);

      const longExtensions = yield* Queue.unbounded<number>();
      const longWorker = yield* Effect.forkChild(
        maintainActiveSandbox(
          {
            extendAutoStop: (_id, hours) =>
              Queue.offer(longExtensions, hours).pipe(Effect.as(sandbox)),
          },
          sandbox.sandboxId,
          Effect.succeed(true),
          { autoStopMinutes: 480 },
        ),
      );
      expect(yield* Queue.take(longExtensions)).toBe(8);
      yield* Fiber.interrupt(longWorker);
    }),
);
