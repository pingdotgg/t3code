// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { encodeGrayscalePng, fetchCourseReference } from "./referenceFetch.ts";

const lookup = (async (hostname: string) => {
  const blocked: Record<string, string> = {
    "private.example": "127.0.0.1",
    "shared.com": "100.100.100.100",
    "zero.com": "0.0.0.0",
  };
  return [{ address: blocked[hostname] ?? "93.184.216.34", family: 4 as const }];
}) as never;

describe("course reference fetch", () => {
  it.effect("rewrites Drive links before fetching", () =>
    Effect.gen(function* () {
      let requested = "";
      yield* fetchCourseReference({
        url: "https://drive.google.com/file/d/abc123/view?usp=drivesdk",
        lookup,
        fetchImpl: (url) => {
          requested = url.toString();
          return Promise.resolve(
            new Response("<title>Solution</title><p>text</p>", { status: 200 }),
          );
        },
      });
      assert.include(requested, "/uc?export=download&id=abc123");
    }),
  );

  it.effect.each(["shared.com", "zero.com"])("rejects special resolved address %s", (host) =>
    Effect.gen(function* () {
      const blocked = yield* fetchCourseReference({
        url: `https://${host}/solution.pdf`,
        lookup,
        fetchImpl: () => Promise.resolve(new Response("", { status: 200 })),
      }).pipe(Effect.flip);
      assert.include(blocked.message, "private network");
    }),
  );

  it.effect("rejects private hosts and private redirect targets", () =>
    Effect.gen(function* () {
      const blocked = yield* fetchCourseReference({
        url: "http://private.example/solution.pdf",
        lookup,
        fetchImpl: () => Promise.resolve(new Response("", { status: 200 })),
      }).pipe(Effect.flip);
      assert.include(blocked.message, "not public");
      const redirected = yield* fetchCourseReference({
        url: "https://example.com/solution.pdf",
        lookup: (async (host: string) =>
          host === "169.254.169.254"
            ? [{ address: "169.254.169.254", family: 4 as const }]
            : lookup(host)) as never,
        fetchImpl: () =>
          Promise.resolve(
            new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
          ),
      }).pipe(Effect.flip);
      assert.include(redirected.message, "not public");
    }),
  );

  it("encodes grayscale PNG dimensions", () => {
    const png = encodeGrayscalePng(new Uint8Array([0, 127, 255, 64]), 2, 2);
    assert.deepStrictEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.strictEqual(Buffer.from(png).readUInt32BE(16), 2);
    assert.strictEqual(Buffer.from(png).readUInt32BE(20), 2);
  });
});
