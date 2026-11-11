// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import { encodeGrayscalePng, extractPdf, fetchCourseReference } from "./referenceFetch.ts";

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
            : (
                lookup as (
                  hostname: string,
                ) => Promise<ReadonlyArray<{ address: string; family: 4 }>>
              )(host)) as never,
        fetchImpl: () =>
          Promise.resolve(
            new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
          ),
      }).pipe(Effect.flip);
      assert.include(redirected.message, "not public");
    }),
  );

  it.effect("audits blocked DNS and redirect targets", () =>
    Effect.gen(function* () {
      const stateDir = `/tmp/course-reference-audit-${process.pid}`;
      yield* Effect.promise(() => NodeFSP.rm(stateDir, { recursive: true, force: true }));
      yield* fetchCourseReference({
        url: "https://example.com/solution.pdf",
        lookup: (async () => [{ address: "127.0.0.1", family: 4 as const }]) as never,
        audit: { stateDir },
      }).pipe(Effect.flip);
      yield* fetchCourseReference({
        url: "https://example.com/solution.pdf",
        lookup: (async (host: string) =>
          host === "169.254.169.254"
            ? [{ address: "169.254.169.254", family: 4 as const }]
            : [{ address: "93.184.216.34", family: 4 as const }]) as never,
        fetchImpl: () =>
          Promise.resolve(
            new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
          ),
        audit: { stateDir },
      }).pipe(Effect.flip);
      const files = yield* Effect.promise(() => NodeFSP.readdir(`${stateDir}/audit`));
      const lines = (yield* Effect.promise(() =>
        NodeFSP.readFile(`${stateDir}/audit/${files[0]!}`, "utf8"),
      ))
        .trim()
        .split("\n");
      assert.include(lines[0]!, '"ips":["127.0.0.1"]');
      assert.include(lines[1]!, "169.254.169.254");
    }),
  );

  it("encodes grayscale PNG dimensions", () => {
    const png = encodeGrayscalePng(new Uint8Array([0, 127, 255, 64]), 2, 2);
    assert.deepStrictEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.strictEqual(Buffer.from(png).readUInt32BE(16), 2);
    assert.strictEqual(Buffer.from(png).readUInt32BE(20), 2);
  });

  it("skips PDF images over the decoder pixel limit", async () => {
    const pdf =
      "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n" +
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n" +
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Im 5 0 R >> >> /Contents 4 0 R >> endobj\n" +
      "4 0 obj << /Length 33 >> stream\nq 100 0 0 100 0 0 cm /Im Do Q\nendstream endobj\n" +
      "5 0 obj << /Type /XObject /Subtype /Image /Width 32000 /Height 32000 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length 8 >> stream\nx\x9c\x03\x00\x00\x00\x00\x01\nendstream endobj\n" +
      "trailer << /Root 1 0 R /Size 6 >>\n%%EOF";
    const result = await extractPdf(Buffer.from(pdf), [1]);
    assert.strictEqual(result.images.length, 0);
  });
});
