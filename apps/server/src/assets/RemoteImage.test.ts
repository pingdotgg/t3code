import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import * as RemoteImage from "./RemoteImage.ts";

function fixture(respond: (url: string) => Response | Error) {
  const requests: Array<{ url: string; headers: Readonly<Record<string, string>> }> = [];
  const http = HttpClient.make((request) => {
    requests.push({ url: request.url, headers: request.headers });
    const response = respond(request.url);
    return response instanceof Error
      ? Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause: response }),
          }),
        )
      : Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  return {
    requests,
    layer: RemoteImage.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http))),
  };
}

it.effect.each(["success", "transport", "body"] as const)(
  "reads signed redirects without credentials or URL-bearing traces: %s",
  (mode) => {
    const spans: Array<Tracer.Span> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const signedUrl = "https://cdn.example.com/shot.png?jwt=private-image-token";
    const test = fixture((url) => {
      if (url === "https://images.example.com/image") {
        return new Response(null, { status: 302, headers: { location: signedUrl } });
      }
      if (mode === "transport") return new Error("Connection failed");
      return new Response(
        mode === "body"
          ? new ReadableStream({
              start: (controller) => controller.error(new Error("Body failed")),
            })
          : "png",
        { headers: { "content-type": "image/png" } },
      );
    });
    return Effect.gen(function* () {
      const images = yield* RemoteImage.RemoteImage;
      const result = yield* images.read("https://images.example.com/image").pipe(Effect.exit);
      if (mode === "success") {
        expect(result._tag).toBe("Success");
        if (result._tag !== "Success") return;
        expect(result.value.mimeType).toBe("image/png");
        expect(new TextDecoder().decode(result.value.bytes)).toBe("png");
      } else {
        expect(result._tag).toBe("Failure");
        const readSpan = spans.find((span) => span.name === "RemoteImage.read");
        expect(readSpan?.status._tag).toBe("Ended");
        if (readSpan?.status._tag !== "Ended" || readSpan.status.exit._tag !== "Failure") {
          throw new Error("Expected a failed image read span");
        }
        expect(Cause.pretty(readSpan.status.exit.cause)).not.toContain("private-image-token");
      }
      expect(spans.filter((span) => span.kind === "client")).toEqual([]);
      expect(test.requests.map(({ url }) => url)).toEqual([
        "https://images.example.com/image",
        signedUrl,
      ]);
      for (const { headers } of test.requests) {
        expect(headers.authorization).toBeUndefined();
        expect(headers.cookie).toBeUndefined();
      }
    }).pipe(Effect.provide(test.layer), Effect.withTracer(tracer), Effect.withTracerEnabled(true));
  },
);

it.effect("rejects private and credential-bearing redirect targets before requesting them", () => {
  const targets = [
    "http://127.0.0.1/private",
    "http://[::1]/private",
    "https://user:password@example.com/image",
    "file:///private/image.png",
  ];
  return Effect.forEach(targets, (target) => {
    const test = fixture(() => new Response(null, { status: 302, headers: { location: target } }));
    return Effect.gen(function* () {
      const images = yield* RemoteImage.RemoteImage;
      expect(
        yield* images.read("https://images.example.com/image").pipe(Effect.flip),
      ).toMatchObject({ reason: "invalid-url" });
      expect(test.requests).toHaveLength(1);
    }).pipe(Effect.provide(test.layer));
  });
});

it.effect("recognizes PNG bytes served as a generic GitHub release download", () => {
  const png = new Uint8Array(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const test = fixture((url) =>
    url === "https://github.com/example/repo/releases/download/proof/shot.png"
      ? new Response(null, {
          status: 302,
          headers: { location: "https://release-assets.githubusercontent.com/shot" },
        })
      : new Response(png, { headers: { "content-type": "application/octet-stream" } }),
  );
  return Effect.gen(function* () {
    const images = yield* RemoteImage.RemoteImage;
    const result = yield* images.read(
      "https://github.com/example/repo/releases/download/proof/shot.png",
    );
    expect(result.mimeType).toBe("image/png");
    expect(result.bytes).toEqual(png);
  }).pipe(Effect.provide(test.layer));
});

it.effect("rejects generic downloads whose bytes are not an image despite their filename", () =>
  Effect.forEach(["<html>not an image</html>", "%PDF-1.7"], (body) => {
    const test = fixture(
      () => new Response(body, { headers: { "content-type": "application/octet-stream" } }),
    );
    return Effect.gen(function* () {
      const images = yield* RemoteImage.RemoteImage;
      expect(
        yield* images.read("https://images.example.com/fake.png").pipe(Effect.flip),
      ).toMatchObject({ reason: "not-image" });
    }).pipe(Effect.provide(test.layer));
  }),
);

it.live("refuses hostnames resolving to private addresses in the real HTTP client", () =>
  Effect.gen(function* () {
    const images = yield* RemoteImage.RemoteImage;
    expect(yield* images.read("http://localhost/image.png").pipe(Effect.flip)).toMatchObject({
      reason: "request",
    });
  }).pipe(Effect.provide(RemoteImage.layerPublic)),
);

it.effect("limits redirect chains", () => {
  const test = fixture(() => new Response(null, { status: 302, headers: { location: "/again" } }));
  return Effect.gen(function* () {
    const images = yield* RemoteImage.RemoteImage;
    expect(yield* images.read("https://images.example.com/image").pipe(Effect.flip)).toMatchObject({
      reason: "redirects",
    });
    expect(test.requests).toHaveLength(4);
  }).pipe(Effect.provide(test.layer));
});

it.effect("rejects HTML and upstream errors", () =>
  Effect.forEach(
    [
      { status: 200, type: "text/html", reason: "not-image" },
      { status: 403, type: "image/png", reason: "status" },
    ],
    ({ status, type, reason }) => {
      const test = fixture(
        () => new Response("content", { status, headers: { "content-type": type } }),
      );
      return Effect.gen(function* () {
        const images = yield* RemoteImage.RemoteImage;
        expect(
          yield* images.read("https://images.example.com/image").pipe(Effect.flip),
        ).toMatchObject({ reason });
      }).pipe(Effect.provide(test.layer));
    },
  ),
);

it.effect("bounds image bodies with and without a declared size", () =>
  Effect.forEach([true, false], (declared) => {
    let cancelled = false;
    const test = fixture(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(32 * 1024 * 1024));
              controller.enqueue(new Uint8Array(1));
            },
            cancel() {
              cancelled = true;
            },
          }),
          {
            headers: {
              "content-type": "image/png",
              ...(declared ? { "content-length": String(32 * 1024 * 1024 + 1) } : {}),
            },
          },
        ),
    );
    return Effect.gen(function* () {
      const images = yield* RemoteImage.RemoteImage;
      expect(
        yield* images.read("https://images.example.com/image").pipe(Effect.flip),
      ).toMatchObject({ reason: "too-large" });
      if (!declared) expect(cancelled).toBe(true);
    }).pipe(Effect.provide(test.layer));
  }),
);
