import * as NodeZlib from "node:zlib";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/http";
import { InferenceProxy } from "./InferenceProxy.ts";
import * as InferenceHttp from "./http.ts";

it("streams an authorized request with a host key, then denies the revoked consumer", async () => {
  let active = true;
  let throttled = false;
  let closed = false;
  let upstreamCalls = 0;
  let linkedHost: string | undefined;
  let finish: (() => void) | undefined;
  const client = HttpClient.make((request, _url, signal) =>
    Effect.sync(() => {
      upstreamCalls++;
      expect(request.url).toBe("http://127.0.0.1:43210/v1/messages?beta=true");
      expect(request.headers.authorization).toBe("Bearer private-host-key");
      expect(request.headers["anthropic-version"]).toBe("2023-06-01");
      expect(request.headers["content-encoding"]).toBe("zstd");
      expect(request.headers["x-codex-turn-state"]).toBe("turn-fixture");
      expect(request.headers["x-codex-turn-metadata"]).toBe("metadata-fixture");
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers["x-api-key"]).toBeUndefined();
      signal.addEventListener("abort", () => {
        closed = true;
      });
      if (throttled)
        return HttpClientResponse.fromWeb(
          request,
          new Response("quota", {
            status: 429,
            headers: { "retry-after": "60", "retry-after-ms": "1200000" },
          }),
        );
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: first\n\n"));
          finish = () => controller.close();
        },
      });
      return HttpClientResponse.fromWeb(
        request,
        new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "set-cookie": "secret=hidden",
            "x-codex-turn-state": "next-turn-fixture",
          },
        }),
      );
    }),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    InferenceHttp.layer.pipe(
      Layer.provide(
        Layer.mock(InferenceProxy)({
          health: (key, hostId) => {
            linkedHost = hostId;
            return Effect.succeed(
              active && key === "consumer"
                ? { availableDrivers: ["codex"], models: ["gpt-fixture"] }
                : null,
            );
          },
          authorize: (key, hostId) => {
            linkedHost = hostId;
            return Effect.succeed(
              active && key === "consumer"
                ? { baseUrl: "http://127.0.0.1:43210", key: "private-host-key" }
                : null,
            );
          },
          routeCandidates: (key, hostId) => {
            linkedHost = hostId;
            return Effect.succeed(
              active && key === "consumer"
                ? [{ baseUrl: "http://127.0.0.1:43210", key: "private-host-key", models: [] }]
                : null,
            );
          },
          hasFallback: () => Effect.succeed(false),
          recordRouteOutcome: () => Effect.void,
        }),
      ),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
    ),
    { disableLogger: true },
  );
  const compressedBody = new Uint8Array(NodeZlib.zstdCompressSync("{}"));
  const request = (path: string, key?: string) =>
    new Request("http://t3.test/api/inference/" + path, {
      method: "POST",
      body: compressedBody,
      headers: {
        "anthropic-version": "2023-06-01",
        "content-encoding": "zstd",
        "x-codex-turn-state": "turn-fixture",
        "x-codex-turn-metadata": "metadata-fixture",
        cookie: "t3session=private",
        ...(key ? { "x-api-key": key } : {}),
      },
    });
  try {
    expect((await handler(request("v0/management/auth-files", "consumer"))).status).toBe(404);
    expect((await handler(request("v1/messages"))).status).toBe(401);
    const result = await handler(request("v1/messages?beta=true", "consumer"));
    expect(result.headers.get("set-cookie")).toBeNull();
    expect(result.headers.get("x-codex-turn-state")).toBe("next-turn-fixture");
    const reader = result.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
    finish!();
    expect((await reader.read()).done).toBe(true);
    expect(closed).toBe(true);
    const linked = await handler(request("linked/codex/host/v1/messages?beta=true", "consumer"));
    expect(linkedHost).toBe("host");
    const linkedReader = linked.body!.getReader();
    expect(new TextDecoder().decode((await linkedReader.read()).value)).toBe("data: first\n\n");
    finish!();
    expect((await linkedReader.read()).done).toBe(true);
    closed = false;
    const interrupted = await handler(request("v1/messages?beta=true", "consumer"));
    const activeReader = interrupted.body!.getReader();
    await activeReader.read();
    await activeReader.cancel();
    expect(closed).toBe(true);
    throttled = true;
    const limited = await handler(request("v1/messages?beta=true", "consumer"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(limited.headers.get("retry-after-ms")).toBe("1200000");
    expect(await limited.text()).toBe("quota");
    const health = await handler(
      new Request("http://t3.test/api/inference/linked/codex/host/health", {
        headers: { authorization: "Bearer consumer" },
      }),
    );
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(await health.json()).toEqual({ availableDrivers: ["codex"], models: ["gpt-fixture"] });
    expect(linkedHost).toBe("host");
    active = false;
    const denied = await handler(request("v1/messages", "consumer"));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      error: { type: "permission_error", message: expect.stringContaining("T3 inference") },
    });
    expect(
      (
        await handler(
          new Request("http://t3.test/api/inference/health", {
            headers: { authorization: "Bearer consumer" },
          }),
        )
      ).status,
    ).toBe(403);
    expect(upstreamCalls).toBe(4);
  } finally {
    await dispose();
  }
});

it("tries another authorized host for the same model after an upstream auth failure", async () => {
  const calls: string[] = [];
  let recordedRetry: unknown;
  let primaryStatus = 403;
  let backupStatus = 200;
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      calls.push(request.url);
      if (request.url.endsWith("/v1/messages"))
        expect(request.headers["x-session-affinity"]).toBe("thread-fixture");
      return HttpClientResponse.fromWeb(
        request,
        request.url.startsWith("http://primary.test") && primaryStatus !== 200
          ? new Response(null, { status: primaryStatus })
          : request.url.startsWith("http://backup.test") && backupStatus !== 200
            ? new Response(null, {
                status: backupStatus,
                headers:
                  backupStatus === 429 ? { "retry-after": "60", "retry-after-ms": "1200000" } : {},
              })
            : request.url.endsWith("/v1/models")
              ? Response.json({
                  object: "list",
                  data: request.url.startsWith("http://primary.test")
                    ? [
                        { id: "claude-fable-5-2", owned_by: "primary" },
                        { id: "claude-alpha", owned_by: "primary" },
                      ]
                    : [
                        { id: "claude-fable-5-2", owned_by: "backup" },
                        { id: "claude-beta", owned_by: "backup" },
                      ],
                })
              : Response.json({ type: "message", model: "claude-fable-5-2" }),
      );
    }),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    InferenceHttp.layer.pipe(
      Layer.provide(
        Layer.mock(InferenceProxy)({
          authorize: () => Effect.succeed({ baseUrl: "http://primary.test", key: "primary-key" }),
          routeCandidates: () =>
            Effect.succeed([
              {
                baseUrl: "http://primary.test",
                key: "primary-key",
                models: ["claude-fable-5-2", "claude-alpha"],
                hostId: EnvironmentId.make("primary"),
              },
              {
                baseUrl: "http://backup.test",
                key: "backup-key",
                models: ["claude-fable-5-2", "claude-beta"],
                hostId: EnvironmentId.make("backup"),
              },
            ]),
          hasFallback: () => Effect.succeed(true),
          recordRouteOutcome: (input) =>
            Effect.sync(() => {
              if (input.status === 429) recordedRetry = input;
            }),
        }),
      ),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
    ),
    { disableLogger: true },
  );
  try {
    const body = JSON.stringify({ model: "claude-fable-5-2", messages: [] });
    const response = await handler(
      new Request("http://t3.test/api/inference/linked/claudeAgent/host/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer consumer",
          "content-type": "application/json",
          "x-session-id": "thread-fixture",
          "x-session-affinity": "thread-fixture",
        },
        body,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ model: "claude-fable-5-2" });
    expect(calls).toEqual(["http://primary.test/v1/messages", "http://backup.test/v1/messages"]);
    const catalog = await handler(
      new Request("http://t3.test/api/inference/linked/claudeAgent/host/v1/models", {
        headers: { authorization: "Bearer consumer" },
      }),
    );
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toEqual({
      object: "list",
      data: [
        { id: "claude-fable-5-2", owned_by: "backup" },
        { id: "claude-beta", owned_by: "backup" },
      ],
    });
    expect(calls.slice(2)).toEqual([
      "http://primary.test/v1/models",
      "http://backup.test/v1/models",
    ]);
    const send = () =>
      handler(
        new Request("http://t3.test/api/inference/linked/claudeAgent/host/v1/messages", {
          method: "POST",
          headers: {
            authorization: "Bearer consumer",
            "content-type": "application/json",
            "x-session-id": "thread-fixture",
            "x-session-affinity": "thread-fixture",
          },
          body,
        }),
      );
    const sticky = await send();
    expect(sticky.status).toBe(200);
    expect(calls.slice(4)).toEqual(["http://backup.test/v1/messages"]);
    backupStatus = 429;
    primaryStatus = 200;
    const rebinding = await send();
    expect(rebinding.status).toBe(200);
    expect(calls.slice(5)).toEqual([
      "http://backup.test/v1/messages",
      "http://primary.test/v1/messages",
    ]);
    expect(recordedRetry).toMatchObject({
      retryAfter: "60",
      retryAfterMs: "1200000",
    });
    const rebound = await send();
    expect(rebound.status).toBe(200);
    expect(calls.slice(7)).toEqual(["http://primary.test/v1/messages"]);
    backupStatus = 200;
    const union = await handler(
      new Request("http://t3.test/api/inference/linked/claudeAgent/host/v1/models", {
        headers: { authorization: "Bearer consumer" },
      }),
    );
    expect(union.status).toBe(200);
    expect(await union.json()).toEqual({
      object: "list",
      data: [
        { id: "claude-fable-5-2", owned_by: "primary" },
        { id: "claude-alpha", owned_by: "primary" },
        { id: "claude-beta", owned_by: "backup" },
      ],
    });
    expect(calls.slice(8)).toEqual([
      "http://primary.test/v1/models",
      "http://backup.test/v1/models",
    ]);
    primaryStatus = 529;
    const overload = await send();
    expect(overload.status).toBe(200);
    expect(calls.slice(10)).toEqual([
      "http://primary.test/v1/messages",
      "http://backup.test/v1/messages",
    ]);
    backupStatus = 400;
    const invalid = await send();
    expect(invalid.status).toBe(400);
    expect(calls.slice(12)).toEqual(["http://backup.test/v1/messages"]);
  } finally {
    await dispose();
  }
});

it("streams an oversized chunked request once without losing its buffered prefix", async () => {
  const calls: string[] = [];
  let received = 0;
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      calls.push(request.url);
      if (request.body._tag !== "Stream") throw new Error("Expected a streaming request body");
      received = yield* Stream.runFold(
        request.body.stream.pipe(Stream.orDie),
        () => 0,
        (total, chunk) => total + chunk.byteLength,
      );
      return HttpClientResponse.fromWeb(request, new Response(null, { status: 403 }));
    }),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    InferenceHttp.layer.pipe(
      Layer.provide(
        Layer.mock(InferenceProxy)({
          routeCandidates: () =>
            Effect.succeed([
              { baseUrl: "http://primary.test", key: "primary-key", models: ["claude-fable-5-2"] },
              { baseUrl: "http://backup.test", key: "backup-key", models: ["claude-fable-5-2"] },
            ]),
          hasFallback: () => Effect.succeed(true),
          recordRouteOutcome: () => Effect.void,
        }),
      ),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
    ),
    { disableLogger: true },
  );
  const chunk = new Uint8Array(1024 * 1024);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < 9; index++) controller.enqueue(chunk);
      controller.close();
    },
  });
  try {
    const response = await handler(
      new Request("http://t3.test/api/inference/linked/claudeAgent/host/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer consumer", "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );
    expect(response.status).toBe(403);
    expect(received).toBe(9 * 1024 * 1024);
    expect(calls).toEqual(["http://primary.test/v1/messages"]);
  } finally {
    await dispose();
  }
});
