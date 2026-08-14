import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe } from "vite-plus/test";

import * as ProcessRunner from "./processRunner.ts";
import {
  assetResponseHeaders,
  isLoopbackHostname,
  proxyGitHubUserAttachment,
  resolveDevRedirectUrl,
} from "./http.ts";

const processResult = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: 0 as ProcessRunner.ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
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
    expect(
      assetResponseHeaders(
        "https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000000",
        "image/svg+xml",
      ),
    ).toHaveProperty("Content-Security-Policy");
  });

  it("does not apply document policy to raster images", () => {
    expect(assetResponseHeaders("/attachments/user-image.png")).toEqual({
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
  });
});

describe("GitHub attachment proxy", () => {
  it.effect("returns 404 without a GitHub token", () =>
    proxyGitHubUserAttachment("https://github.com/user-attachments/assets/id").pipe(
      Effect.provide(
        Layer.merge(
          Layer.succeed(ProcessRunner.ProcessRunner, {
            run: () => Effect.succeed(processResult("")),
          }),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("unexpected fetch")),
          ),
        ),
      ),
      Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(404))),
    ),
  );

  it.effect("streams authenticated images with safe headers", () => {
    const httpClient = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
        ),
      ),
    );
    return proxyGitHubUserAttachment("https://github.com/user-attachments/assets/id").pipe(
      Effect.provide(
        Layer.merge(
          Layer.succeed(ProcessRunner.ProcessRunner, {
            run: () => Effect.succeed(processResult("token\n")),
          }),
          Layer.succeed(HttpClient.HttpClient, httpClient),
        ),
      ),
      Effect.tap((response) =>
        Effect.sync(() => {
          expect(response.status).toBe(200);
          expect(response.headers["content-type"]).toBe("image/svg+xml");
          expect(response.headers["content-security-policy"]).toContain("sandbox");
          expect(response.body._tag).toBe("Stream");
        }),
      ),
    );
  });
});
