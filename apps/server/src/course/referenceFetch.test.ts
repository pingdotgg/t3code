// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import { EventEmitter } from "node:events";
import {
  checkedDispatcher,
  encodeGrayscalePng,
  extractPdf,
  fetchCourseReference,
} from "./referenceFetch.ts";

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

  it.effect("pins the dispatcher to the address checked by DNS", () =>
    Effect.promise(async () => {
      let calls = 0;
      const checked = await checkedDispatcher("example.com", (async () => {
        calls += 1;
        return [{ address: calls === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 as const }];
      }) as never);
      let connected = "";
      checked.connectLookup!("example.com", {}, (error, address) => {
        if (error) throw error;
        connected = typeof address === "string" ? address : address[0]!.address;
      });
      assert.strictEqual(connected, "93.184.216.34");
      assert.strictEqual(calls, 1);
      const optionsSymbol = Object.getOwnPropertySymbols(checked.dispatcher!).find(
        (symbol) => symbol.description === "options",
      );
      const options = Reflect.get(checked.dispatcher!, optionsSymbol!) as {
        connect: { lookup: unknown };
      };
      assert.strictEqual(options.connect.lookup, checked.connectLookup);
      await checked.dispatcher?.close();
    }),
  );

  it.effect("rejects URL userinfo", () =>
    Effect.gen(function* () {
      const failure = yield* fetchCourseReference({
        url: "https://user:password@example.com/solution.pdf",
        lookup,
        fetchImpl: () => Promise.resolve(new Response("", { status: 200 })),
      }).pipe(Effect.flip);
      assert.include(failure.message, "userinfo");
    }),
  );

  it.effect.each(["text/html", "application/pdf"])("rejects final 404 %s", (contentType) =>
    Effect.gen(function* () {
      const failure = yield* fetchCourseReference({
        url:
          contentType === "application/pdf"
            ? "https://example.com/missing.pdf"
            : "https://example.com/",
        lookup,
        fetchImpl: () =>
          Promise.resolve(
            new Response(contentType === "application/pdf" ? "%PDF-" : "missing", {
              status: 404,
              headers: { "content-type": contentType },
            }),
          ),
      }).pipe(Effect.flip);
      assert.include(failure.message, "HTTP 404");
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

  it("encodes non-square grayscale PNG dimensions", () => {
    const png = encodeGrayscalePng(new Uint8Array([0, 127, 255, 64, 32, 16]), 3, 2);
    assert.strictEqual(Buffer.from(png).readUInt32BE(16), 3);
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
    assert.strictEqual(result.images?.length, 0);
  });

  it("skips a page with too many image objects before decoding them", async () => {
    let images = "";
    for (let index = 5; index < 15; index += 1)
      images += `${index} 0 obj << /Type /XObject /Subtype /Image /Width 4000 /Height 4000 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 0 >> stream\nendstream endobj\n`;
    const pdf =
      "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n" +
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n" +
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Im 5 0 R >> >> /Contents 4 0 R >> endobj\n" +
      "4 0 obj << /Length 33 >> stream\nq 100 0 0 100 0 0 cm /Im Do Q\nendstream endobj\n" +
      images +
      "trailer << /Root 1 0 R /Size 15 >>\n%%EOF";
    const result = await extractPdf(Buffer.from(pdf), [1]);
    assert.isAtMost(result.images?.length ?? 0, 1);
  });

  it("caps extracted PDF text across requested pages", async () => {
    const text = Array.from({ length: 2_000 }, () => "(AAAAAAAAAA) Tj 0 0 Td").join(" ");
    const stream = (object: number, value: string) =>
      `${object} 0 obj << /Length ${value.length} >> stream\n${value}\nendstream endobj\n`;
    const pdf =
      "%PDF-1.4\n" +
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n" +
      "2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj\n" +
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >> endobj\n" +
      "4 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >> endobj\n" +
      stream(5, `BT /F1 12 Tf ${text} ET`) +
      stream(6, `BT /F1 12 Tf ${text} ET`) +
      "7 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n" +
      "trailer << /Root 1 0 R /Size 8 >>\n%%EOF";
    const result = await extractPdf(Buffer.from(pdf), [1, 2]);
    assert.isAbove(result.pages[0]?.text.length ?? 0, 0);
    assert.strictEqual(
      result.pages.reduce((sum, page) => sum + page.text.length, 0),
      20_000,
    );
  });

  it("processes only the requested PDF pages", async () => {
    const pdf = Buffer.from(
      "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n" +
        "2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj\n" +
        "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 5 0 R >> endobj\n" +
        "4 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 6 0 R >> endobj\n" +
        "5 0 obj << /Length 22 >> stream\nBT (page one) Tj ET\nendstream endobj\n" +
        "6 0 obj << /Length 22 >> stream\nBT (page two) Tj ET\nendstream endobj\n" +
        "trailer << /Root 1 0 R /Size 7 >>\n%%EOF",
    );
    const result = await extractPdf(pdf, [1]);
    assert.deepStrictEqual(
      result.pages?.map((page) => page.page),
      [1],
    );
  });

  it("kills an over-sized PDF worker", async () => {
    const child = new EventEmitter() as any;
    child.pid = 42;
    child.exitCode = null;
    child.killed = false;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => undefined };
    child.kill = () => {
      child.killed = true;
      child.exitCode = null;
      queueMicrotask(() => child.emit("close", null));
      return true;
    };
    const spawn = (() => child) as never;
    const failure = await extractPdf(new Uint8Array(), [1], spawn, {
      rssLimitBytes: 1,
      readRss: async () => 2,
      pollMs: 1,
      timeoutMs: 10_000,
    }).catch((error) => error);
    assert.include(String(failure), "PDF too large or slow to read");
  });

  it("kills a PDF worker after the timeout", async () => {
    const child = new EventEmitter() as any;
    child.pid = 43;
    child.exitCode = null;
    child.killed = false;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => undefined };
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => child.emit("close", null));
      return true;
    };
    const failure = await extractPdf(new Uint8Array(), [1], (() => child) as never, {
      timeoutMs: 1,
      pollMs: 1000,
      readRss: async () => undefined,
    }).catch((error) => error);
    assert.include(String(failure), "PDF too large or slow to read");
  });
});
