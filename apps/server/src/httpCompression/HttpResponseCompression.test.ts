import { expect, it } from "@effect/vitest";
import * as NodeStream from "node:stream";
import * as Effect from "effect/Effect";

import * as HttpResponseCompression from "./HttpResponseCompression.ts";

it.effect("uses a native Node stream", () =>
  Effect.gen(function* () {
    const compression = yield* HttpResponseCompression.HttpResponseCompression;
    const response = compression.gzip(new Uint8Array(), {});

    expect(response.body._tag).toBe("Raw");
    if (response.body._tag === "Raw") {
      expect(response.body.body).toBeInstanceOf(NodeStream.Readable);
    }
  }).pipe(Effect.provide(HttpResponseCompression.layerNode)),
);

it.effect("uses a native Web stream for Bun", () =>
  Effect.gen(function* () {
    const compression = yield* HttpResponseCompression.HttpResponseCompression;
    const response = compression.gzip(new Uint8Array(), {});

    expect(response.body._tag).toBe("Raw");
    if (response.body._tag === "Raw") {
      expect(response.body.body).toBeInstanceOf(ReadableStream);
    }
  }).pipe(Effect.provide(HttpResponseCompression.layerBun)),
);
