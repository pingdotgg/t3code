import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";

import { postUnifiedPush } from "./unifiedPushSend.ts";

const fakeEndpoint = (statuses: ReadonlyArray<number>) => {
  const bodies: Array<Record<string, string>> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      if (request.body._tag === "Uint8Array") {
        bodies.push(JSON.parse(new TextDecoder().decode(request.body.body)));
      }
      const status = statuses[Math.min(bodies.length - 1, statuses.length - 1)]!;
      return HttpClientResponse.fromWeb(request, new Response(null, { status }));
    }),
  );
  return { client, bodies };
};

const post = (endpoint: ReturnType<typeof fakeEndpoint>) =>
  postUnifiedPush("https://push.example/up", {
    alert_id: "alert",
    updated_at: "0",
  }).pipe(Effect.provideService(HttpClient.HttpClient, endpoint.client));

describe("postUnifiedPush", () => {
  it.effect("retries server errors with the same alert and a fresh timestamp", () =>
    Effect.gen(function* () {
      const endpoint = fakeEndpoint([503, 502, 201]);
      const fiber = yield* post(endpoint).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(fiber)).toEqual({ outcome: "accepted", status: 201 });
      expect(endpoint.bodies.map((body) => body.alert_id)).toEqual(["alert", "alert", "alert"]);
      expect(endpoint.bodies.at(-1)?.updated_at).toBe("3000");
    }),
  );

  it.effect("stops after ten minutes of failures", () =>
    Effect.gen(function* () {
      const endpoint = fakeEndpoint([500]);
      const fiber = yield* post(endpoint).pipe(Effect.forkChild);
      yield* TestClock.adjust("11 minutes");
      expect(yield* Fiber.join(fiber)).toEqual({ outcome: "expired", status: undefined });
      expect(endpoint.bodies.length).toBeLessThan(20);
    }),
  );

  it.effect("gives up on a request that stalls past the deadline", () =>
    Effect.gen(function* () {
      const client = HttpClient.make(() => Effect.never);
      const fiber = yield* postUnifiedPush("https://push.example/up", {
        alert_id: "alert",
        updated_at: "0",
      }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.forkChild);
      yield* TestClock.adjust("10 minutes");
      expect(yield* Fiber.join(fiber)).toEqual({ outcome: "expired", status: undefined });
    }),
  );

  it.effect("drops a message that waited in the queue past the phone's freshness window", () =>
    Effect.gen(function* () {
      const endpoint = fakeEndpoint([201]);
      yield* TestClock.adjust("11 minutes");
      expect(yield* post(endpoint)).toEqual({ outcome: "expired", status: undefined });
      expect(endpoint.bodies).toHaveLength(0);
    }),
  );

  it.effect("encrypts for a Web Push subscription when the config has its keys", () =>
    Effect.gen(function* () {
      const seen: Array<{ headers: Record<string, string>; bytes: number; plain: boolean }> = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          const body = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array();
          seen.push({
            headers: { ...request.headers },
            bytes: body.length,
            plain: new TextDecoder().decode(body).includes("alert_id"),
          });
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 201 }));
        }),
      );
      const result = yield* postUnifiedPush(
        "https://push.example/up",
        { alert_id: "alert", updated_at: "0" },
        {
          p256dh:
            "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
          auth: "BTBZMqHH6r4Tts7J_aSIgg",
        },
      ).pipe(Effect.provideService(HttpClient.HttpClient, client));
      expect(result.outcome).toBe("accepted");
      expect(seen).toHaveLength(1);
      expect(seen[0]?.plain).toBe(false);
      expect(seen[0]?.headers).toMatchObject({
        "content-encoding": "aes128gcm",
        ttl: "600",
        urgency: "high",
      });
    }),
  );

  it.effect("reports a removed endpoint without retrying", () =>
    Effect.gen(function* () {
      for (const status of [404, 410]) {
        const endpoint = fakeEndpoint([status]);
        expect(yield* post(endpoint)).toEqual({ outcome: "gone", status });
        expect(endpoint.bodies).toHaveLength(1);
      }
    }),
  );
});
