import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpServerResponse } from "effect/unstable/http";

import {
  assetResponseHeaders,
  assetFileResponse,
  downloadContentDisposition,
  isLoopbackHostname,
  resolveDevRedirectUrl,
} from "./http.ts";

const fileResponseLayer = Layer.mergeAll(NodeHttpPlatform.layer, NodeServices.layer);

describe("video asset byte ranges", () => {
  it.effect("streams exactly the requested bytes and leaves full downloads intact", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-video-range-" });
      const file = path.join(directory, "clip.mp4");
      yield* fs.writeFileString(file, "0123456789");
      const asset = { path: file, mimeType: "video/mp4" };
      for (const [header, expected, contentRange] of [
        ["bytes=0-1", "01", "bytes 0-1/10"],
        ["bytes=4-", "456789", "bytes 4-9/10"],
        ["bytes=-3", "789", "bytes 7-9/10"],
        ["bytes=-999999999999999999999999", "0123456789", "bytes 0-9/10"],
        ["bytes=8-999999999999999999999999", "89", "bytes 8-9/10"],
      ] as const) {
        const response = HttpServerResponse.toWeb(yield* assetFileResponse(asset, header));
        expect(response.status).toBe(206);
        expect(response.headers.get("accept-ranges")).toBe("bytes");
        expect(response.headers.get("content-range")).toBe(contentRange);
        expect(response.headers.get("content-length")).toBe(String(expected.length));
        expect(yield* Effect.promise(() => response.text())).toBe(expected);
      }
      for (const header of [
        undefined,
        "items=0-1",
        "bytes=0-1,4-5",
        "bytes=8-2",
        "bytes=-",
        "bytes=bad",
      ]) {
        const response = HttpServerResponse.toWeb(yield* assetFileResponse(asset, header));
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.text())).toBe("0123456789");
      }
      const conditional = HttpServerResponse.toWeb(
        yield* assetFileResponse(asset, "bytes=0-1", '"old-etag"'),
      );
      expect(conditional.status).toBe(200);
      expect(yield* Effect.promise(() => conditional.text())).toBe("0123456789");
      const uppercase = HttpServerResponse.toWeb(
        yield* assetFileResponse({ ...asset, mimeType: "Video/MP4" }, "bytes=0-1"),
      );
      expect(uppercase.status).toBe(206);
      expect(yield* Effect.promise(() => uppercase.text())).toBe("01");
      const image = HttpServerResponse.toWeb(
        yield* assetFileResponse({ path: file, mimeType: "image/png" }, "bytes=0-1"),
      );
      expect(image.status).toBe(200);
      expect(image.headers.has("accept-ranges")).toBe(false);
      expect(yield* Effect.promise(() => image.text())).toBe("0123456789");
    }).pipe(Effect.provide(fileResponseLayer)),
  );

  it.effect("rejects ranges outside the file, including empty files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-video-range-" });
      const file = path.join(directory, "clip.mp4");
      yield* fs.writeFileString(file, "0123456789");
      for (const header of ["bytes=10-", "bytes=-0", "bytes=999999999999999999999999-"]) {
        const response = HttpServerResponse.toWeb(
          yield* assetFileResponse({ path: file, mimeType: "video/mp4" }, header),
        );
        expect(response.status).toBe(416);
        expect(response.headers.get("content-range")).toBe("bytes */10");
        expect(yield* Effect.promise(() => response.text())).toBe("");
      }
      yield* fs.writeFileString(file, "");
      const empty = HttpServerResponse.toWeb(
        yield* assetFileResponse({ path: file, mimeType: "video/mp4" }, "bytes=0-1"),
      );
      expect(empty.status).toBe(416);
      expect(empty.headers.get("content-range")).toBe("bytes */0");
    }).pipe(Effect.provide(fileResponseLayer)),
  );
});

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});

describe("assetResponseHeaders", () => {
  it("sandboxes SVG assets", () => {
    expect(assetResponseHeaders("/attachments/user-image.svg")).toMatchObject({
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
    });
    expect(assetResponseHeaders("/attachments/user-image.SVG")).toHaveProperty(
      "Content-Security-Policy",
    );
  });

  it("does not apply document policy to raster images", () => {
    expect(assetResponseHeaders("/attachments/user-image.png")).toEqual({
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
  });

  it("serves inline videos with their declared mime type", () => {
    expect(
      assetResponseHeaders("/attachments/demo.bin", {
        mimeType: 'video/mp4; codecs="avc1.42E01E"',
      }),
    ).toEqual({
      "Cache-Control": "private, max-age=3600",
      "Content-Type": "video/mp4",
      "X-Content-Type-Options": "nosniff",
    });
  });
  it("declares utf-8 for HTML assets so non-ASCII content renders correctly", () => {
    expect(assetResponseHeaders("/workspace/page.html")).toHaveProperty(
      "Content-Type",
      "text/html; charset=utf-8",
    );
    expect(assetResponseHeaders("/workspace/PAGE.HTM")).toHaveProperty(
      "Content-Type",
      "text/html; charset=utf-8",
    );
  });

  it("downloads uploaded documents without executing their content", () => {
    expect(assetResponseHeaders("/attachments/upload.html", { download: true })).toMatchObject({
      "Content-Disposition": "attachment",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Type": "application/octet-stream",
    });
  });

  it("serves the real filename and mime type when the claims carry them", () => {
    expect(
      assetResponseHeaders("/attachments/thread-1-abc-pdf.pdf", {
        download: true,
        fileName: "Q3 report.pdf",
        mimeType: "application/pdf",
      }),
    ).toMatchObject({
      "Content-Disposition": 'attachment; filename="Q3 report.pdf"',
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Type": "application/pdf",
    });
  });

  it("keeps renderable mime types as octet-stream downloads", () => {
    for (const mimeType of [
      "text/html",
      "text/xml",
      "image/svg+xml",
      "application/xhtml+xml",
      "application/rss+xml",
      "APPLICATION/XML",
      "IMAGE/SVG+XML",
      "application/xml-dtd",
      "application/xml-external-parsed-entity",
      "not a mime",
    ]) {
      expect(
        assetResponseHeaders("/attachments/upload.bin", { download: true, mimeType }),
      ).toHaveProperty("Content-Type", "application/octet-stream");
    }
  });

  it("preserves official Office Open XML mime types", () => {
    for (const mimeType of [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ]) {
      expect(
        assetResponseHeaders("/attachments/upload.bin", { download: true, mimeType }),
      ).toHaveProperty("Content-Type", mimeType);
    }
  });
});

describe("downloadContentDisposition", () => {
  it("quotes plain names and strips quotes and control characters", () => {
    expect(downloadContentDisposition("report.pdf")).toBe('attachment; filename="report.pdf"');
    expect(downloadContentDisposition('we"ird\n.pdf')).toBe('attachment; filename="we_ird_.pdf"');
  });

  it("adds an RFC 5987 encoded name for non-ASCII filenames", () => {
    expect(downloadContentDisposition("répört.pdf")).toBe(
      `attachment; filename="r_p_rt.pdf"; filename*=UTF-8''r%C3%A9p%C3%B6rt.pdf`,
    );
    expect(downloadContentDisposition("résumé'(*).pdf")).toBe(
      `attachment; filename="r_sum_'(*).pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%27%28%2A%29.pdf`,
    );
  });

  it("does not throw on unpaired surrogates in the filename", () => {
    expect(downloadContentDisposition("bad\ud800name.pdf")).toBe(
      `attachment; filename="bad_name.pdf"; filename*=UTF-8''bad%EF%BF%BDname.pdf`,
    );
  });
});
