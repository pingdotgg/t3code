import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";

import { downloadText } from "./fullFileText";
import { RENDERED_MAX_LINES } from "./largeTextProtocol";

const encoder = new TextEncoder();

const download = (file: Uint8Array) =>
  downloadText("http://localhost/assets/file.ts").pipe(
    Stream.runLast,
    Effect.map(Option.getOrThrow),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, () => Promise.resolve(new Response(file.slice()))),
  );

describe("downloadText", () => {
  it.effect(
    "drops a leading byte order mark as the preview read does, and keeps a later U+FEFF",
    () =>
      Effect.gen(function* () {
        const whole = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode("one\n﻿two\n")]);
        expect((yield* download(whole)).text).toBe("one\n﻿two\n");
      }),
  );

  it.effect("stops at the first text past the lines the main thread can lay out", () =>
    Effect.gen(function* () {
      const file = yield* download(encoder.encode("\n".repeat(RENDERED_MAX_LINES + 10)));
      expect(file.lines).toBeGreaterThan(RENDERED_MAX_LINES);
    }),
  );
});
