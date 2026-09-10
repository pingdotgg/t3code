/**
 * Tests for cron / `scheduled()` support:
 *
 * - The entry middleware's manual trigger route, mirroring Miniflare's
 *   `/cdn-cgi/handler/scheduled` (`workers-sdk/packages/miniflare/src/workers/core/scheduled.ts`):
 *   `cron` / `time` / `format=json` query params and the legacy
 *   `/cdn-cgi/mf/scheduled` path.
 * - The Node-side cron timer (`RuntimeWorker.crons`), which fires the same
 *   route at every cron match so `scheduled()` actually runs during local
 *   development (Miniflare and wrangler have no timer). The test uses a
 *   six-field seconds expression so a real fire is observed within seconds.
 */
import { assert, expect, layer } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { TestWorker } from "../helpers/runtime.ts";
import {
  localRuntimeLayer,
  poll,
  startTestWorker,
} from "../helpers/runtime.ts";

// Records every `scheduled()` invocation into a module-global array, read
// back via `GET /fires`. A `cron` of "throw" makes the handler throw so the
// route's error path can be asserted.
const SCHEDULED_SCRIPT = `
const fires = (globalThis.__fires ??= []);
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/fires") return Response.json(fires);
    return new Response("fetch-ok");
  },
  async scheduled(controller) {
    fires.push({ cron: controller.cron, scheduledTime: controller.scheduledTime });
    if (controller.cron === "throw") {
      throw new Error("scheduled handler boom");
    }
  },
};
`;

interface Fire {
  cron: string;
  scheduledTime: number;
}

class ScheduledTestWorker extends Context.Service<
  ScheduledTestWorker,
  TestWorker
>()("test/ScheduledTestWorker") {}

const ScheduledTestWorkerLive = Layer.effect(
  ScheduledTestWorker,
  startTestWorker({
    name: "scheduled-test",
    compatibilityDate: "2026-03-10",
    compatibilityFlags: [],
    modules: [{ name: "main.js", type: "ESModule", content: SCHEDULED_SCRIPT }],
    bindings: [],
  }),
);

layer(ScheduledTestWorkerLive.pipe(Layer.provideMerge(localRuntimeLayer)), {
  excludeTestServices: true,
})("scheduled trigger route", (it) => {
  it.effect("invokes scheduled() with the given cron and time", () =>
    Effect.gen(function* () {
      const worker = yield* ScheduledTestWorker;
      const cron = "*/15 * * * *";
      const response = yield* worker.fetch(
        `/cdn-cgi/handler/scheduled?cron=${encodeURIComponent(cron)}&time=1000`,
        { method: "POST" },
      );
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.text())).toBe("ok");
      const fires = yield* worker.fetchJson<Array<Fire>>("/fires");
      expect(fires).toContainEqual({ cron, scheduledTime: 1000 });
    }),
  );

  it.effect("defaults cron and scheduledTime when params are omitted", () =>
    Effect.gen(function* () {
      const worker = yield* ScheduledTestWorker;
      const before = (yield* worker.fetchJson<Array<Fire>>("/fires")).length;
      const response = yield* worker.fetch("/cdn-cgi/handler/scheduled", {
        method: "POST",
      });
      expect(response.status).toBe(200);
      const fires = yield* worker.fetchJson<Array<Fire>>("/fires");
      expect(fires.length).toBe(before + 1);
      const fire = fires[fires.length - 1];
      expect(fire.cron).toBe("");
      expect(typeof fire.scheduledTime).toBe("number");
    }),
  );

  it.effect("returns the full result as JSON with format=json", () =>
    Effect.gen(function* () {
      const worker = yield* ScheduledTestWorker;
      const result = yield* worker.fetchJson<{
        outcome: string;
        noRetry: boolean;
      }>("/cdn-cgi/handler/scheduled?cron=json-case&time=42&format=json", {
        method: "POST",
      });
      expect(result.outcome).toBe("ok");
      expect(result.noRetry).toBe(false);
      const fires = yield* worker.fetchJson<Array<Fire>>("/fires");
      expect(fires).toContainEqual({ cron: "json-case", scheduledTime: 42 });
    }),
  );

  it.effect("supports the legacy /cdn-cgi/mf/scheduled path", () =>
    Effect.gen(function* () {
      const worker = yield* ScheduledTestWorker;
      const response = yield* worker.fetch(
        "/cdn-cgi/mf/scheduled?cron=legacy-case&time=7",
        {
          method: "POST",
        },
      );
      expect(response.status).toBe(200);
      const fires = yield* worker.fetchJson<Array<Fire>>("/fires");
      expect(fires).toContainEqual({ cron: "legacy-case", scheduledTime: 7 });
    }),
  );

  it.effect("returns 500 when the scheduled handler throws", () =>
    Effect.gen(function* () {
      const worker = yield* ScheduledTestWorker;
      const response = yield* worker.fetch(
        "/cdn-cgi/handler/scheduled?cron=throw",
        {
          method: "POST",
        },
      );
      expect(response.status).toBe(500);
    }),
  );

  it.effect("does not shadow user routes outside /cdn-cgi", () =>
    Effect.gen(function* () {
      const worker = yield* ScheduledTestWorker;
      expect(yield* worker.fetchText("/anything")).toBe("fetch-ok");
    }),
  );
});

layer(localRuntimeLayer, { excludeTestServices: true })("cron timer", (it) => {
  it.effect(
    "fires scheduled() on a running timer",
    () =>
      Effect.gen(function* () {
        // Six-field expression (seconds granularity, supported by effect's
        // `Cron`) so the timer observably fires within a couple of seconds —
        // production five-field crons follow the same code path with the
        // seconds field defaulted to 0.
        const cron = "* * * * * *";
        const worker = yield* startTestWorker({
          name: "scheduled-timer-test",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          modules: [
            { name: "main.js", type: "ESModule", content: SCHEDULED_SCRIPT },
          ],
          bindings: [],
          crons: [cron],
        });
        const fires = yield* poll<Array<Fire>>(
          worker,
          "/fires",
          (f) => f.length >= 2,
          15_000,
        );
        for (const fire of fires.slice(0, 2)) {
          expect(fire.cron).toBe(cron);
          expect(typeof fire.scheduledTime).toBe("number");
        }
        // Consecutive fires land on distinct cron matches (distinct seconds).
        expect(
          fires[1].scheduledTime - fires[0].scheduledTime,
        ).toBeGreaterThanOrEqual(500);
      }),
    { timeout: 30_000 },
  );

  it.effect("rejects an invalid cron expression with a ConfigError", () =>
    Effect.gen(function* () {
      const error = yield* startTestWorker({
        name: "scheduled-invalid-cron",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: [],
        modules: [
          { name: "main.js", type: "ESModule", content: SCHEDULED_SCRIPT },
        ],
        bindings: [],
        crons: ["not a cron"],
      }).pipe(Effect.flip);
      assert.equal(error._tag, "ConfigError");
      expect(error.message).toContain("Invalid cron expression");
    }),
  );
});
