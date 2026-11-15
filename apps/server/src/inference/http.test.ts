import * as NodeZlib from "node:zlib";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
          new Response("quota", { status: 429, headers: { "retry-after": "60" } }),
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
    const linked = await handler(request("linked/host/v1/messages?beta=true", "consumer"));
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
    expect(await limited.text()).toBe("quota");
    const health = await handler(
      new Request("http://t3.test/api/inference/linked/host/health", {
        headers: { authorization: "Bearer consumer" },
      }),
    );
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(await health.json()).toEqual({ availableDrivers: ["codex"], models: ["gpt-fixture"] });
    expect(linkedHost).toBe("host");
    active = false;
    expect((await handler(request("v1/messages", "consumer"))).status).toBe(403);
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
