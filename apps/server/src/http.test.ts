import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { describe } from "vite-plus/test";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpServerResponse } from "effect/unstable/http";
import { openMediaFile } from "./assets/MediaFile.ts";

import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as ServerConfig from "./config.ts";

import {
  assetResponseHeaders,
  browserApiCorsLayer,
  downloadContentDisposition,
  isLoopbackHostname,
  resolveDevRedirectUrl,
} from "./http.ts";

describe("browser API CORS", () => {
  it("accepts protocol negotiation with authenticated browser headers", async () => {
    const routeLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        const router = yield* HttpRouter.HttpRouter;
        yield* router.add("GET", "/api/environment", HttpServerResponse.empty());
      }),
    );
    const appLayer = Layer.merge(routeLayer, browserApiCorsLayer).pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "http-cors-test-" })),
      Layer.provide(NodeServices.layer),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(appLayer, { disableLogger: true });

    try {
      const response = await handler(
        new Request("https://backend.example/api/environment", {
          method: "OPTIONS",
          headers: {
            origin: "https://app.t3.codes",
            "access-control-request-method": "GET",
            "access-control-request-headers": [
              ORCHESTRATION_PROTOCOL_HEADER,
              "authorization",
              "dpop",
            ].join(", "),
          },
        }),
      );

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      const allowedHeaders = new Set(
        (response.headers.get("access-control-allow-headers") ?? "")
          .split(",")
          .map((header) => header.trim().toLowerCase()),
      );
      expect(allowedHeaders.has(ORCHESTRATION_PROTOCOL_HEADER)).toBe(true);
      expect(allowedHeaders.has("authorization")).toBe(true);
      expect(allowedHeaders.has("dpop")).toBe(true);
    } finally {
      await dispose();
    }
  });
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
  it("serves inline attachment documents with their declared mime type", () => {
    expect(
      assetResponseHeaders("/attachments/upload.bin", { mimeType: "application/pdf" }),
    ).toMatchObject({
      "Content-Type": "application/pdf",
    });
    expect(
      assetResponseHeaders("/attachments/upload.bin", { mimeType: "text/html" }),
    ).toMatchObject({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-modals",
    });
  });
  it("serves HTML assets as utf-8 inside a sandboxed origin", () => {
    for (const path of ["/workspace/page.html", "/workspace/PAGE.HTM", "/tmp/report.html"]) {
      expect(assetResponseHeaders(path)).toMatchObject({
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-modals",
      });
    }
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
