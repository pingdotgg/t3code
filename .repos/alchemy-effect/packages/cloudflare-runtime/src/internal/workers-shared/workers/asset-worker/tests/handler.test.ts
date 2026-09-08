// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { describe, it, vi } from "vitest";
import { mockJaegerBinding } from "../../../shared/tracing.ts";
import { Analytics } from "../src/analytics.ts";
import { SEC_FETCH_MODE_NAVIGATE_HEADER_PREFERS_ASSET_SERVING } from "../src/compatibility-flags.ts";
import { normalizeConfiguration } from "../src/configuration.ts";
import { canFetch, handleRequest } from "../src/handler.ts";
import type { AssetConfig } from "../../../shared/types.ts";

const mockEnv = {
  JAEGER: mockJaegerBinding(),
};

describe("[Asset Worker] `handleRequest`", () => {
  const analytics = new Analytics();

  it("attaches ETag headers to responses", async ({ expect }) => {
    const configuration: AssetConfig = normalizeConfiguration({
      html_handling: "none",
      not_found_handling: "none",
    });
    const eTag = "some-etag";
    const exists = vi.fn().mockReturnValue(eTag);
    const getByETag = vi.fn().mockReturnValue({
      readableStream: new ReadableStream(),
      contentType: "text/html",
      cacheStatus: "HIT",
    });

    const response = await handleRequest(
      new Request("https://example.com/"),
      // @ts-expect-error Empty config default to using mocked jaeger
      mockEnv,
      configuration,
      exists,
      getByETag,
      analytics,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe(`"${eTag}"`);
  });

  it("returns 304 Not Modified responses for a valid strong ETag in If-None-Match", async ({
    expect,
  }) => {
    const configuration: AssetConfig = normalizeConfiguration({
      html_handling: "none",
      not_found_handling: "none",
    });
    const eTag = "some-etag";
    const exists = vi.fn().mockReturnValue(eTag);
    const getByETag = vi.fn().mockReturnValue({
      readableStream: new ReadableStream(),
      contentType: "text/html",
      cacheStatus: "HIT",
    });

    const response = await handleRequest(
      new Request("https://example.com/", {
        headers: { "If-None-Match": `"${eTag}"` },
      }),
      // @ts-expect-error Empty config default to using mocked jaeger
      mockEnv,
      configuration,
      exists,
      getByETag,
      analytics,
    );

    expect(response.status).toBe(304);
  });

  it("returns 304 Not Modified responses for a valid weak ETag in If-None-Match", async ({
    expect,
  }) => {
    const configuration: AssetConfig = normalizeConfiguration({
      html_handling: "none",
      not_found_handling: "none",
    });
    const eTag = "some-etag";
    const exists = vi.fn().mockReturnValue(eTag);
    const getByETag = vi.fn().mockReturnValue({
      readableStream: new ReadableStream(),
      contentType: "text/html",
      cacheStatus: "HIT",
    });

    const response = await handleRequest(
      new Request("https://example.com/", {
        headers: { "If-None-Match": `W/"${eTag}"` },
      }),
      // @ts-expect-error Empty config default to using mocked jaeger
      mockEnv,
      configuration,
      exists,
      getByETag,
      analytics,
    );

    expect(response.status).toBe(304);
  });

  it("returns 200 OK responses for an invalid ETag in If-None-Match", async ({
    expect,
  }) => {
    const configuration: AssetConfig = normalizeConfiguration({
      html_handling: "none",
      not_found_handling: "none",
    });
    const eTag = "some-etag";
    const exists = vi.fn().mockReturnValue(eTag);
    const getByETag = vi.fn().mockReturnValue({
      readableStream: new ReadableStream(),
      contentType: "text/html",
      cacheStatus: "HIT",
    });

    const response = await handleRequest(
      new Request("https://example.com/", {
        headers: { "If-None-Match": "a fake etag!" },
      }),
      // @ts-expect-error Empty config default to using mocked jaeger
      mockEnv,
      configuration,
      exists,
      getByETag,
      analytics,
    );

    expect(response.status).toBe(200);
  });

  it("cannot fetch assets outside of configured path", async ({ expect }) => {
    const assets: Record<string, string> = {
      "/blog/test.html": "aaaaaaaaaa",
      "/blog/index.html": "bbbbbbbbbb",
      "/index.html": "cccccccccc",
      "/test.html": "dddddddddd",
    };

    // Attempt to path traverse down to the root /test within asset-server
    let response = await handleRequest(
      new Request("https://example.com/blog/../test"),
      // @ts-expect-error Empty config default to using mocked jaeger
      mockEnv,
      normalizeConfiguration({}),
      async (pathname: string) => {
        if (pathname.startsWith("/blog/")) {
          // our route
          return assets[pathname] ?? null;
        } else {
          return null;
        }
      },
      async (_: string) => ({
        readableStream: new ReadableStream(),
        contentType: "text/html",
        cacheStatus: "HIT",
      }),
      analytics,
    );

    expect(response.status).toBe(404);

    // Attempt to path traverse down to the root /test within asset-server
    response = await handleRequest(
      new Request("https://example.com/blog/%2E%2E/test"),
      // @ts-expect-error Empty config default to using mocked jaeger
      mockEnv,
      normalizeConfiguration({}),
      async (pathname: string) => {
        if (pathname.startsWith("/blog/")) {
          // our route
          return assets[pathname] ?? null;
        } else {
          return null;
        }
      },
      async (_: string) => ({
        readableStream: new ReadableStream(),
        contentType: "text/html",
        cacheStatus: "HIT",
      }),
      analytics,
    );

    expect(response.status).toBe(404);
  });

  it("returns expected responses for malformed path", async ({ expect }) => {
    const assets: Record<string, string> = {
      "/index.html": "aaaaaaaaaa",
      "/%A0%A0.html": "bbbbbbbbbb",
    };
    const configuration: AssetConfig = normalizeConfiguration({
      html_handling: "drop-trailing-slash",
      not_found_handling: "none",
    });

    const exists = async (pathname: string) => {
      return assets[pathname] ?? null;
    };
    const getByEtag = async (_: string) => ({
      readableStream: new ReadableStream(),
      contentType: "text/html",
      cachesStatus: "HIT",
    });

    // first malformed URL should return 404 as no match above
    const response = await handleRequest(
      new Request("https://example.com/%A0"),
      // @ts-expect-error Empty config default to using mocked jaeger
      mockEnv,
      configuration,
      exists,
      getByEtag,
      analytics,
    );
    expect(response.status).toBe(404);

    // but second malformed URL should return 307 as it matches and then redirects
    const response2 = await handleRequest(
      new Request("https://example.com/%A0%A0"),
      // @ts-expect-error Empty config default to using mocked jaeger
      mockEnv,
      configuration,
      exists,
      getByEtag,
      analytics,
    );
    expect(response2.status).toBe(307);
  });

  it("attaches CF-Cache-Status headers to responses", async ({ expect }) => {
    const configuration: AssetConfig = normalizeConfiguration({
      html_handling: "none",
      not_found_handling: "none",
    });
    const eTag = "some-etag";
    const exists = vi.fn().mockReturnValue(eTag);
    let getByEtag = vi.fn().mockReturnValueOnce({
      readableStream: new ReadableStream(),
      contentType: "text/html",
      cacheStatus: "HIT",
    });

    // Test cache HIT
    const cacheHitResponse = await handleRequest(
      new Request("https://example.com/"),
      // @ts-expect-error Empty config default to using mocked jaeger
      mockEnv,
      configuration,
      exists,
      getByEtag,
      analytics,
    );

    expect(cacheHitResponse.status).toBe(200);
    expect(cacheHitResponse.headers.get("CF-Cache-Status")).toBe("HIT");

    // Test cache MISS
    getByEtag = vi.fn().mockReturnValueOnce({
      readableStream: new ReadableStream(),
      contentType: "text/html",
      cacheStatus: "MISS",
    });

    const cacheMissResponse = await handleRequest(
      new Request("https://example.com/"),
      // @ts-expect-error Empty config default to using mocked jaeger
      mockEnv,
      configuration,
      exists,
      getByEtag,
      analytics,
    );

    expect(cacheMissResponse.status).toBe(200);
    expect(cacheMissResponse.headers.get("CF-Cache-Status")).toBe("MISS");
  });

  describe("_headers", () => {
    it("attaches custom headers", async ({ expect }) => {
      const configuration: AssetConfig = normalizeConfiguration({
        html_handling: "none",
        not_found_handling: "none",
        headers: {
          version: 2,
          rules: {
            "/": {
              set: {
                "X-Custom-Header": "Custom-Value",
              },
            },
            "/foo": {
              set: {
                "X-Custom-Foo-Header": "Custom-Foo-Value",
              },
            },
            "/bang/:placeheld": {
              set: {
                "X-Custom-Bang-Header": "Custom-Bang-Value :placeheld",
              },
            },
            "/art/*": {
              set: {
                "X-Custom-Art-Header": "Custom-Art-Value :splat",
                "Set-Cookie": "me",
              },
            },
            "/art/nested/attack": {
              set: {
                "Set-Cookie": "me too",
              },
            },
            "/system/override": {
              set: {
                ETag: "very rogue",
              },
            },
            "/system/underride": {
              unset: ["ETAg"],
            },
            "/art/nested/unset/attack*": {
              unset: ["Set-Cookie"],
              set: {
                "Set-Cookie": "hijack",
              },
            },
            "/art/nested/unset/attack/totalunset": {
              unset: ["Set-Cookie"],
            },
            "/foo.html": {
              set: {
                "X-Custom-Foo-HTML-Header": "Custom-Foo-HTML-Value",
              },
            },
          },
        },
      });
      const eTag = "some-etag";
      const exists = vi.fn().mockReturnValue(eTag);
      const getByETag = vi.fn().mockReturnValue({
        readableStream: new ReadableStream(),
        contentType: "text/html",
      });

      // Static header on root
      let response = await handleRequest(
        new Request("https://example.com/"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        getByETag,
        analytics,
      );

      expect(response.headers.get("X-Custom-Header")).toBe("Custom-Value");
      expect(response.headers.has("X-Custom-Foo-Header")).toBeFalsy();

      // Static header on path
      response = await handleRequest(
        new Request("https://example.com/foo"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        getByETag,
        analytics,
      );

      expect(response.headers.get("X-Custom-Foo-Header")).toBe(
        "Custom-Foo-Value",
      );
      expect(response.headers.has("X-Custom-Header")).toBeFalsy();

      // Placeholder header
      response = await handleRequest(
        new Request("https://example.com/bang/baz"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        getByETag,
        analytics,
      );

      expect(response.headers.get("X-Custom-Bang-Header")).toBe(
        "Custom-Bang-Value baz",
      );

      // Placeholder doesn't catch children
      response = await handleRequest(
        new Request("https://example.com/bang/baz/abba"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        getByETag,
        analytics,
      );

      expect(response.headers.has("X-Custom-Bang-Header")).toBeFalsy();

      // Splat header
      response = await handleRequest(
        new Request("https://example.com/art/attack/by/Neil/Buchanan"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        getByETag,
        analytics,
      );

      expect(response.headers.get("X-Custom-Art-Header")).toBe(
        "Custom-Art-Value attack/by/Neil/Buchanan",
      );
      expect(response.headers.get("Set-Cookie")).toBe("me");

      // Headers are appended
      response = await handleRequest(
        new Request("https://example.com/art/nested/attack"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        getByETag,
        analytics,
      );

      expect(response.headers.get("Set-Cookie")).toBe("me, me too");

      // System headers are overwritten
      response = await handleRequest(
        new Request("https://example.com/system/override"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        getByETag,
        analytics,
      );

      expect(response.headers.get("ETag")).toBe("very rogue");

      // System headers can be unset
      response = await handleRequest(
        new Request("https://example.com/system/underride"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        getByETag,
        analytics,
      );

      expect(response.headers.has("ETag")).toBeFalsy();

      // Custom headers can be unset and redefined
      response = await handleRequest(
        new Request("https://example.com/art/nested/unset/attack"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        getByETag,
        analytics,
      );

      expect(response.headers.get("Set-Cookie")).toBe("hijack");

      // Custom headers can entirely unset
      response = await handleRequest(
        new Request("https://example.com/art/nested/unset/attack/totalunset"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        getByETag,
        analytics,
      );

      expect(response.headers.has("Set-Cookie")).toBeFalsy();

      // Custom headers are applied even to redirect responses
      response = await handleRequest(
        new Request("https://example.com/foo.html"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        { ...configuration, html_handling: "auto-trailing-slash" },
        (pathname: string) => {
          if (pathname === "/foo.html") {
            return true;
          }

          return false;
        },
        getByETag,
        analytics,
      );

      expect(response.headers.get("Location")).toBe("/foo");
      expect(response.headers.get("X-Custom-Foo-HTML-Header")).toBe(
        "Custom-Foo-HTML-Value",
      );

      // Custom headers are applied even to not modified responses
      response = await handleRequest(
        new Request("https://example.com/foo", {
          headers: { "If-None-Match": `"${eTag}"` },
        }),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        getByETag,
        analytics,
      );

      expect(response.status).toBe(304);
      expect(response.headers.get("X-Custom-Foo-Header")).toBe(
        "Custom-Foo-Value",
      );

      // Custom headers are applied even to custom redirect responses
      response = await handleRequest(
        new Request("https://example.com/foo"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        {
          ...configuration,
          redirects: {
            version: 1,
            staticRules: {},
            rules: { "/foo": { status: 301, to: "/bar" } },
          },
        },
        () => null,
        () => {
          throw new Error("bang");
        },
        analytics,
      );

      expect(response.status).toBe(301);
      expect(response.headers.get("Location")).toBe("/bar");
      expect(response.headers.get("X-Custom-Foo-Header")).toBe(
        "Custom-Foo-Value",
      );
    });
  });

  describe("_redirects", () => {
    it("evaluates custom redirects", async ({ expect }) => {
      const configuration: AssetConfig = normalizeConfiguration({
        html_handling: "none",
        not_found_handling: "none",
        redirects: {
          version: 1,
          staticRules: {
            "/foo": {
              status: 301,
              to: "/bar",
              lineNumber: 1,
            },
            "/proxy": {
              status: 200,
              to: "/other",
              lineNumber: 2,
            },
            "/proxy-explicit": {
              status: 200,
              to: "/other.html",
              lineNumber: 3,
            },
            "/competeForwards": {
              status: 302,
              to: "/hostless",
              lineNumber: 4,
            },
            "https://example.com/competeForwards": {
              status: 302,
              to: "/withhost",
              lineNumber: 5,
            },
            "https://example.com/competeBackwards": {
              status: 302,
              to: "/withhost",
              lineNumber: 6,
            },
            "/competeBackwards": {
              status: 302,
              to: "/hostless",
              lineNumber: 7,
            },
            "/wonkyObjectOrder": {
              status: 302,
              to: "/hostless",
              lineNumber: 9,
            },
            "https://example.com/wonkyObjectOrder": {
              status: 302,
              to: "/withhost",
              lineNumber: 8,
            },
          },
          rules: {
            "/dynamic/:seg": {
              status: 302,
              to: "/:seg/new-dynamic/?with#params",
            },
            "/dynamic/:seg1/:seg2/:seg3": {
              status: 302,
              to: "https://fakehost/:seg3/:seg1/:seg2/new-dynamic/?with#params",
            },
            "/splat/*": {
              status: 302,
              to: "/:splat/new-splat",
            },
            "/splat/foo/*": {
              status: 302,
              to: "/will-never-fire",
            },
            "/but/this/will/*": {
              status: 302,
              to: "/too",
            },
            "/but/this/*": {
              status: 302,
              to: "/will",
            },
            "/partialSplat*": {
              status: 302,
              to: "/new-partialSplat:splat",
            },
            "/partialPlaceholder:placeholder": {
              status: 302,
              to: "/new-partialPlaceholder:placeholder",
            },
          },
        },
      });
      const eTag = "some-etag";
      const exists = vi.fn().mockReturnValue(eTag);
      const getByETag = vi.fn().mockReturnValue({
        readableStream: new ReadableStream(),
        contentType: "text/html",
      });

      // Static redirect in front of an asset
      let response = await handleRequest(
        new Request("https://example.com/foo"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        getByETag,
        analytics,
      );

      expect(response.status).toBe(301);
      expect(response.headers.get("Location")).toBe("/bar");

      // Static redirect with no underlying asset
      response = await handleRequest(
        new Request("https://example.com/foo"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        () => null,
        () => {
          throw new Error("bang");
        },
        analytics,
      );

      expect(response.status).toBe(301);
      expect(response.headers.get("Location")).toBe("/bar");

      // Proxy to another non-HTML asset
      response = await handleRequest(
        new Request("https://example.com/proxy"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        (pathname: string) => {
          if (pathname === "/other") {
            return "other-etag";
          }

          return null;
        },
        (requestedETag: string) => {
          if (requestedETag === "other-etag") {
            return {
              readableStream: new ReadableStream({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode("hello from other asset!"),
                  );
                  controller.close();
                },
              }),
              contentType: "application/octet-stream",
            };
          }
          throw new Error("bang");
        },
        analytics,
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("hello from other asset!");

      // Proxy to another nearby HTML asset implicitly
      response = await handleRequest(
        new Request("https://example.com/proxy"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        { ...configuration, html_handling: "auto-trailing-slash" },
        (pathname: string) => {
          if (pathname === "/other.html") {
            return "other-etag";
          }

          return null;
        },
        (requestedETag: string) => {
          if (requestedETag === "other-etag") {
            return {
              readableStream: new ReadableStream({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode("hello from other asset!"),
                  );
                  controller.close();
                },
              }),
              contentType: "text/html",
            };
          }
          throw new Error("bang");
        },
        analytics,
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("hello from other asset!");

      // Proxy to another HTML asset explicitly
      response = await handleRequest(
        new Request("https://example.com/proxy-explicit"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        (pathname: string) => {
          if (pathname === "/other.html") {
            return "other-etag";
          }

          return null;
        },
        (requestedETag: string) => {
          if (requestedETag === "other-etag") {
            return {
              readableStream: new ReadableStream({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode("hello from other asset!"),
                  );
                  controller.close();
                },
              }),
              contentType: "text/html",
            };
          }
          throw new Error("bang");
        },
        analytics,
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("hello from other asset!");

      // Proxy a non-existent asset with not_found_handling
      response = await handleRequest(
        new Request("https://example.com/proxy"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        { ...configuration, not_found_handling: "404-page" },
        (pathname: string) => {
          if (pathname === "/404.html") {
            return "404-etag";
          }

          return null;
        },
        (requestedETag: string) => {
          if (requestedETag === "404-etag") {
            return {
              readableStream: new ReadableStream({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode("hello from 404.html!"),
                  );
                  controller.close();
                },
              }),
              contentType: "text/html",
            };
          }
          throw new Error("bang");
        },
        analytics,
      );

      expect(response.status).toBe(404);
      expect(await response.text()).toBe("hello from 404.html!");

      // Proxy a non-existent asset without not_found_handling
      response = await handleRequest(
        new Request("https://example.com/proxy"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        { ...configuration, not_found_handling: "none" },
        () => {
          return null;
        },
        () => {
          throw new Error("bang");
        },
        analytics,
      );

      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");

      // Static redirects evaluate in line order
      response = await handleRequest(
        new Request("https://example.com/competeForwards"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        getByETag,
        analytics,
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/hostless");

      response = await handleRequest(
        new Request("https://example.com/competeBackwards"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        getByETag,
        analytics,
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/withhost");

      response = await handleRequest(
        new Request("https://example.com/wonkyObjectOrder"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        getByETag,
        analytics,
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/withhost");

      // Dynamic placeholders work
      response = await handleRequest(
        new Request("https://example.com/dynamic/foo"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        getByETag,
        analytics,
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(
        "/foo/new-dynamic/?with#params",
      );

      response = await handleRequest(
        new Request("https://example.com/dynamic/bar/baz/qux"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        getByETag,
        analytics,
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(
        "https://fakehost/qux/bar/baz/new-dynamic/?with#params",
      );

      response = await handleRequest(
        new Request(
          "https://example.com/dynamic/bar/baz/qux/too/many/segments",
        ),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        getByETag,
        analytics,
      );

      expect(response.status).toBe(200);

      // Dynamic splats work
      response = await handleRequest(
        new Request("https://example.com/splat/foo/bar/baz"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        getByETag,
        analytics,
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/foo/bar/baz/new-splat");

      response = await handleRequest(
        new Request("https://example.com/splat/"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        getByETag,
        analytics,
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/new-splat");

      // Dynamic rules are first-come-first-serve
      response = await handleRequest(
        new Request("https://example.com/splat/foo/nope"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        getByETag,
        analytics,
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/foo/nope/new-splat");

      response = await handleRequest(
        new Request("https://example.com/but/this/match"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        getByETag,
        analytics,
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/will");

      response = await handleRequest(
        new Request("https://example.com/but/this/will/match"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        getByETag,
        analytics,
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/too");

      // Partial splats and placeholders work
      response = await handleRequest(
        new Request("https://example.com/partialSplatfoo/bar/baz"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        getByETag,
        analytics,
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(
        "/new-partialSplatfoo/bar/baz",
      );

      response = await handleRequest(
        new Request("https://example.com/partialPlaceholderfoo"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        getByETag,
        analytics,
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(
        "/new-partialPlaceholderfoo",
      );

      response = await handleRequest(
        new Request("https://example.com/partialPlaceholderfoo/"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        getByETag,
        analytics,
      );

      expect(response.status).toBe(200);
    });

    it("should prevent external redirects via double slash", async ({
      expect,
    }) => {
      const configuration: AssetConfig = normalizeConfiguration({
        html_handling: "none",
        not_found_handling: "none",
        redirects: {
          version: 1,
          staticRules: {},
          rules: {
            "/foo/*": {
              status: 302,
              to: "/:splat",
            },
          },
        },
      });
      const exists = vi.fn().mockReturnValue(null);
      const getByETag = vi.fn().mockReturnValue({
        readableStream: new ReadableStream(),
        contentType: "text/html",
      });

      // Test the vulnerability: double slash should not create external redirect
      const response = await handleRequest(
        new Request("https://example.com/foo//google.com"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        getByETag,
        analytics,
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("Location");

      // SECURITY: Location should be relative, not absolute
      // The vulnerability would cause: location to be "https://google.com"
      // The fix should make: location be ".//google.com" (relative)
      expect(location).toBe("/google.com");
      expect(location).not.toMatch(/^https?:\/\//);
    });
  });
});

describe("[Asset Worker] `canFetch`", () => {
  it('should return "true" if for exact and nearby assets with html_handling on', async ({
    expect,
  }) => {
    const exists = (pathname: string) => {
      if (pathname === "/foo.html") {
        return "some-etag";
      }

      return null;
    };

    expect(
      await canFetch(
        new Request("https://example.com/foo.html"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        normalizeConfiguration({ html_handling: "auto-trailing-slash" }),
        exists,
      ),
    ).toBeTruthy();

    expect(
      await canFetch(
        new Request("https://example.com/foo"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        normalizeConfiguration({ html_handling: "auto-trailing-slash" }),
        exists,
      ),
    ).toBeTruthy();

    expect(
      await canFetch(
        new Request("https://example.com/foo/"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        normalizeConfiguration({ html_handling: "auto-trailing-slash" }),
        exists,
      ),
    ).toBeTruthy();
  });

  it("should not consider 404s or SPAs", async ({ expect }) => {
    const exists = (pathname: string) => {
      if (["/404.html", "/index.html", "/foo.html"].includes(pathname)) {
        return "some-etag";
      }

      return null;
    };

    for (const notFoundHandling of [
      "single-page-application",
      "404-page",
    ] as const) {
      expect(
        await canFetch(
          new Request("https://example.com/foo"),
          // @ts-expect-error Empty config default to using mocked jaeger
          mockEnv,
          normalizeConfiguration({ not_found_handling: notFoundHandling }),
          exists,
        ),
      ).toBeTruthy();

      expect(
        await canFetch(
          new Request("https://example.com/bar"),
          // @ts-expect-error Empty config default to using mocked jaeger
          mockEnv,
          normalizeConfiguration({ not_found_handling: notFoundHandling }),
          exists,
        ),
      ).toBeFalsy();

      expect(
        await canFetch(
          new Request("https://example.com/"),
          // @ts-expect-error Empty config default to using mocked jaeger
          mockEnv,
          normalizeConfiguration({ not_found_handling: notFoundHandling }),
          exists,
        ),
      ).toBeTruthy();

      expect(
        await canFetch(
          new Request("https://example.com/404"),
          // @ts-expect-error Empty config default to using mocked jaeger
          mockEnv,
          normalizeConfiguration({ not_found_handling: notFoundHandling }),
          exists,
        ),
      ).toBeTruthy();
    }
  });

  describe('should always return "true" for 404s or SPAs when static routing is present', () => {
    const exists = (pathname: string) => {
      // only our special files are present
      if (["/404.html", "/index.html"].includes(pathname)) {
        return "some-etag";
      }

      return null;
    };

    for (const notFoundHandling of [
      "single-page-application",
      "404-page",
    ] as const) {
      for (const headers of [{}, { "Sec-Fetch-Mode": "navigate" }] as Array<
        Record<string, string>
      >) {
        for (const flags of [
          [SEC_FETCH_MODE_NAVIGATE_HEADER_PREFERS_ASSET_SERVING.disable],
          [SEC_FETCH_MODE_NAVIGATE_HEADER_PREFERS_ASSET_SERVING.enable],
        ]) {
          const config = normalizeConfiguration({
            not_found_handling: notFoundHandling,
            compatibility_flags: flags,
            has_static_routing: true,
          });

          it(`notFoundHandling=${notFoundHandling} Sec-Fetch-Mode=${headers["Sec-Fetch-Mode"]} flags=${flags}`, async ({
            expect,
          }) => {
            expect(
              await canFetch(
                new Request("https://example.com/foo", { headers }),
                // @ts-expect-error Empty config default to using mocked jaeger
                mockEnv,
                config,
                exists,
              ),
            ).toBeTruthy();

            expect(
              await canFetch(
                new Request("https://example.com/bar", { headers }),
                // @ts-expect-error Empty config default to using mocked jaeger
                mockEnv,
                config,
                exists,
              ),
            ).toBeTruthy();

            expect(
              await canFetch(
                new Request("https://example.com/", { headers }),
                // @ts-expect-error Empty config default to using mocked jaeger
                mockEnv,
                config,
                exists,
              ),
            ).toBeTruthy();

            expect(
              await canFetch(
                new Request("https://example.com/404", { headers }),
                // @ts-expect-error Empty config default to using mocked jaeger
                mockEnv,
                config,
                exists,
              ),
            ).toBeTruthy();
          });
        }
      }
    }
  });

  it('should return "true" even for a bad method', async ({ expect }) => {
    const exists = (pathname: string) => {
      if (pathname === "/foo.html") {
        return "some-etag";
      }

      return null;
    };

    expect(
      await canFetch(
        new Request("https://example.com/foo", { method: "POST" }),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        normalizeConfiguration(),
        exists,
      ),
    ).toBeTruthy();

    expect(
      await canFetch(
        new Request("https://example.com/bar", { method: "POST" }),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        normalizeConfiguration(),
        exists,
      ),
    ).toBeFalsy();
  });

  it('should return "true" for custom redirects without underlying assets', async ({
    expect,
  }) => {
    const exists = (pathname: string) => {
      if (["/404.html", "/does-exist"].includes(pathname)) {
        return "some-etag";
      }

      return null;
    };

    const configuration = normalizeConfiguration({
      redirects: {
        version: 1,
        staticRules: {
          "/redirect": {
            status: 301,
            to: "/something",
            lineNumber: 1,
          },
          "/proxy-valid": {
            status: 200,
            to: "/does-exist",
            lineNumber: 2,
          },
          "/proxy-invalid": {
            status: 200,
            to: "/no-match",
            lineNumber: 3,
          },
        },
        rules: {},
      },
    });

    expect(
      await canFetch(
        new Request("https://example.com/does-exist"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
      ),
    ).toBeTruthy();

    expect(
      await canFetch(
        new Request("https://example.com/no-match"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
      ),
    ).toBeFalsy();

    expect(
      await canFetch(
        new Request("https://example.com/redirect"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
      ),
    ).toBeTruthy();

    expect(
      await canFetch(
        new Request("https://example.com/proxy-valid"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
      ),
    ).toBeTruthy();

    expect(
      await canFetch(
        new Request("https://example.com/proxy-invalid"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        { ...configuration, not_found_handling: "none" },
        () => {
          return null;
        },
      ),
    ).toBeTruthy();

    expect(
      await canFetch(
        new Request("https://example.com/proxy-invalid"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        { ...configuration, not_found_handling: "404-page" },
        () => {
          return null;
        },
      ),
    ).toBeTruthy();
  });

  describe("assets_navigation_prefers_asset_serving", () => {
    const exists = (pathname: string) => {
      if (["/404.html", "/index.html", "/foo.html"].includes(pathname)) {
        return "some-etag";
      }

      return null;
    };

    interface CompatibilityOptions {
      compatibilityDate?: string;
      compatibilityFlags?: Array<string>;
    }

    const compatibilityOptionsModes: Array<[CompatibilityOptions, boolean]> = [
      [{}, false],
      [
        {
          compatibilityFlags: ["assets_navigation_prefers_asset_serving"],
        },
        true,
      ],
      [
        {
          compatibilityFlags: ["assets_navigation_has_no_effect"],
        },
        false,
      ],
      [
        {
          // Impossible in reality since workerd objects to mutually exclusive flags
          compatibilityFlags: [
            "assets_navigation_prefers_asset_serving",
            "assets_navigation_has_no_effect",
          ],
        },
        true,
      ],
      [
        {
          compatibilityDate: "2099-12-12",
        },
        true,
      ],
      [
        {
          compatibilityDate: "2099-12-12",
          compatibilityFlags: ["assets_navigation_prefers_asset_serving"],
        },
        true,
      ],
      [
        {
          compatibilityDate: "2099-12-12",
          compatibilityFlags: ["assets_navigation_has_no_effect"],
        },
        false,
      ],
    ] as const;

    const notFoundHandlingModes = [
      [undefined, false],
      ["none", false],
      ["404-page", true],
      ["single-page-application", true],
    ] as const;

    const headersModes = [
      [{}, false],
      [{ "Sec-Fetch-Mode": "navigate" }, true],
      [{ "Sec-Fetch-Mode": "cors" }, false],
    ] as const;

    const hasStaticRoutingModes = [
      [false, false],
      [true, true],
    ] as const;

    const matrix = [];
    for (const compatibilityOptions of compatibilityOptionsModes) {
      for (const notFoundHandling of notFoundHandlingModes) {
        for (const headers of headersModes) {
          for (const hasStaticRouting of hasStaticRoutingModes) {
            matrix.push({
              compatibilityDate: compatibilityOptions[0].compatibilityDate,
              compatibilityFlags: compatibilityOptions[0].compatibilityFlags,
              notFoundHandling: notFoundHandling[0],
              headers: headers[0],
              hasStaticRouting: hasStaticRouting[0],
              expected:
                (hasStaticRouting[1] && notFoundHandling[1]) ||
                (compatibilityOptions[1] && notFoundHandling[1] && headers[1]),
            });
          }
        }
      }
    }

    it.for(matrix)(
      "compatibility_date $compatibilityDate, compatibility_flags $compatibilityFlags, not_found_handling $notFoundHandling, headers: $headers, hasStaticRouting $hasStaticRouting -> $expected",
      async (
        {
          compatibilityDate,
          compatibilityFlags,
          notFoundHandling,
          headers,
          hasStaticRouting,
          expected,
        },
        { expect },
      ) => {
        expect(
          await canFetch(
            new Request("https://example.com/foo", { headers }),
            // @ts-expect-error Empty config default to using mocked jaeger
            mockEnv,
            normalizeConfiguration({
              compatibility_date: compatibilityDate,
              compatibility_flags: compatibilityFlags,
              not_found_handling: notFoundHandling,
              has_static_routing: hasStaticRouting,
            }),
            exists,
          ),
        ).toBeTruthy();

        expect(
          await canFetch(
            new Request("https://example.com/bar", { headers }),
            // @ts-expect-error Empty config default to using mocked jaeger
            mockEnv,
            normalizeConfiguration({
              compatibility_date: compatibilityDate,
              compatibility_flags: compatibilityFlags,
              not_found_handling: notFoundHandling,
              has_static_routing: hasStaticRouting,
            }),
            exists,
          ),
        ).toBe(expected);

        expect(
          await canFetch(
            new Request("https://example.com/", { headers }),
            // @ts-expect-error Empty config default to using mocked jaeger
            mockEnv,
            normalizeConfiguration({
              compatibility_date: compatibilityDate,
              compatibility_flags: compatibilityFlags,
              not_found_handling: notFoundHandling,
              has_static_routing: hasStaticRouting,
            }),
            exists,
          ),
        ).toBeTruthy();

        expect(
          await canFetch(
            new Request("https://example.com/404", { headers }),
            // @ts-expect-error Empty config default to using mocked jaeger
            mockEnv,
            normalizeConfiguration({
              compatibility_date: compatibilityDate,
              compatibility_flags: compatibilityFlags,
              not_found_handling: notFoundHandling,
              has_static_routing: hasStaticRouting,
            }),
            exists,
          ),
        ).toBeTruthy();
      },
    );
  });
});
