// @effect-diagnostics nodeBuiltinImport:off - the reader test seeds a fake
// opencode home on disk with real temp dirs, outside the Effect FileSystem.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { openCodeGoUsageToLimits, readOpenCodeGoUsageLimits } from "./openCodeGoUsageLimits.ts";

const checkedAt = "2026-09-11T19:00:00.000Z";

describe("openCodeGoUsageToLimits", () => {
  it("maps each window with its kind and duration, skipping ones without a reading", () => {
    const limits = openCodeGoUsageToLimits({
      checkedAt,
      response: {
        usage: {
          rolling: { percent: null, resetsAt: null },
          weekly: { percent: 150, resetsAt: "not a date" },
          monthly: { percent: 19, resetsAt: "2026-09-30T15:05:58.242Z" },
        },
      },
    });
    expect(limits.checkedAt).toBe(checkedAt);
    expect(
      limits.windows.map((window) => [
        window.id,
        window.kind,
        window.label,
        window.usedPercent,
        window.windowDurationMins,
        window.resetsAt,
      ]),
    ).toEqual([
      ["go_weekly", "weekly", "Weekly", 100, 10_080, undefined],
      ["go_monthly", "monthly", "Monthly", 19, 43_200, "2026-09-30T15:05:58.242Z"],
    ]);
  });
});

/**
 * A throwaway opencode data dir whose auth.json holds other services, plus a
 * Go entry when a key is given.
 */
const goHome = Effect.fn("goHome")(function* (goKey: string | null) {
  const home = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "opencode-go-test-")),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
  );
  const dataDir = NodePath.join(home, ".local", "share", "opencode");
  yield* Effect.promise(() => NodeFSP.mkdir(dataDir, { recursive: true }));
  const goEntry = goKey === null ? "" : `,"opencode-go":{"type":"api","key":"${goKey}"}`;
  yield* Effect.promise(() =>
    NodeFSP.writeFile(
      NodePath.join(dataDir, "auth.json"),
      `{"openai":{"type":"oauth","refresh":"rt-123","access":"eyJhbGciOi"}${goEntry}}`,
    ),
  );
  return home;
});

describe("readOpenCodeGoUsageLimits", () => {
  effectIt.effect("reads quota with the Go key from a fake opencode home", () =>
    Effect.gen(function* () {
      const home = yield* goHome("sk-test-go");
      const seen: Array<string> = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          seen.push(request.headers.authorization ?? "");
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              usage: {
                rolling: { status: "ok", percent: 7, resetsAt: "2026-09-11T20:33:17.242Z" },
                weekly: { status: "ok", percent: 10, resetsAt: "2026-09-14T00:00:00.242Z" },
                monthly: { status: "ok", percent: 19, resetsAt: "2026-09-30T15:05:58.242Z" },
              },
            }),
          );
        }),
      );
      const limits = yield* readOpenCodeGoUsageLimits({
        environment: { HOME: home },
        checkedAt,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provide(NodeServices.layer),
      );
      expect(seen).toEqual(["Bearer sk-test-go"]);
      expect(limits?.windows.map((window) => [window.id, window.kind, window.usedPercent])).toEqual(
        [
          ["go_rolling", "session", 7],
          ["go_weekly", "weekly", 10],
          ["go_monthly", "monthly", 19],
        ],
      );
    }),
  );

  effectIt.effect("reports a rejected key without clearing the last snapshot", () =>
    Effect.gen(function* () {
      const home = yield* goHome("sk-stale");
      const http = HttpClient.make((request) =>
        Effect.sync(() => HttpClientResponse.fromWeb(request, new Response(null, { status: 401 }))),
      );
      const limits = yield* readOpenCodeGoUsageLimits({
        environment: { HOME: home },
        checkedAt,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provide(NodeServices.layer),
      );
      expect(limits?.unavailable).toMatchObject({ reason: "probeFailed" });
      expect(limits?.unavailable?.message).toContain("rejected its API key");
    }),
  );

  effectIt.effect("reports an unreadable auth.json instead of treating it as no subscription", () =>
    Effect.gen(function* () {
      const home = yield* goHome("sk-test-go");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(home, ".local", "share", "opencode", "auth.json"), "{oops"),
      );
      const limits = yield* readOpenCodeGoUsageLimits({
        environment: { HOME: home },
        checkedAt,
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Effect.die(new Error("HttpClient must not be called without a key")),
          ),
        ),
        Effect.provide(NodeServices.layer),
      );
      expect(limits?.unavailable).toMatchObject({ reason: "probeFailed" });
      expect(limits?.unavailable?.message).toContain("auth.json");
    }),
  );

  effectIt.effect("leaves limits alone without a Go subscription", () =>
    Effect.gen(function* () {
      const home = yield* goHome(null);
      const limits = yield* readOpenCodeGoUsageLimits({
        environment: { HOME: home },
        checkedAt,
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Effect.die(new Error("HttpClient must not be called without a key")),
          ),
        ),
        Effect.provide(NodeServices.layer),
      );
      expect(limits).toBe(undefined);
    }),
  );
});
