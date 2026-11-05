// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { createExecutionContext } from "cloudflare:test";
import { describe, it, vi } from "vitest";
import { mockJaegerBinding, mockJaegerBindingSpan } from "../../../shared/tracing.ts";
import type { AssetConfig } from "../../../shared/types.ts";
import type { JaegerRecord, JaegerTracing } from "../../../shared/types.ts";
import { Analytics } from "../src/analytics.ts";
import { normalizeConfiguration } from "../src/configuration.ts";
import { canFetch, getIntent, handleRequest } from "../src/handler.ts";
import { AssetWorkerInner } from "../src/worker.ts";
import type { Env } from "../src/worker.ts";

const mockEnv = {
  JAEGER: mockJaegerBinding(),
};

function mockGetByETag() {
  return vi.fn().mockReturnValue({
    readableStream: new ReadableStream(),
    contentType: "text/html",
    cacheStatus: "HIT",
  });
}

function recordingJaegerBinding() {
  const spans = new Map<string, JaegerRecord>();
  const binding: JaegerTracing = {
    ...mockJaegerBinding(),
    enterSpan: (name, callback, ...args) =>
      callback(
        {
          ...mockJaegerBindingSpan(),
          setTags: (tags) => spans.set(name, tags),
        },
        ...args,
      ),
  };

  return { binding, spans };
}

describe("[Asset Worker] `base_path` handling", () => {
  const analytics = new Analytics();

  it("normalizes an omitted base_path to the root default", ({ expect }) => {
    const configuration = normalizeConfiguration({});
    expect(configuration.base_path).toBe("/");
  });

  it("normalizes pathname-like base_path inputs", ({ expect }) => {
    expect(normalizeConfiguration({ base_path: "/subpath" }).base_path).toBe("/subpath/");
    expect(normalizeConfiguration({ base_path: "./subpath" }).base_path).toBe("/subpath/");
    expect(normalizeConfiguration({ base_path: "/a/./b/../c" }).base_path).toBe("/a/c/");
  });

  it("rejects URL-shaped base_path inputs", ({ expect }) => {
    expect(() =>
      normalizeConfiguration({
        base_path: "https://example.com/subpath",
      }),
    ).toThrow("Invalid assets base_path");
  });

  it("serves an in-prefix asset by looking up the stripped path", async ({ expect }) => {
    const configuration: AssetConfig = normalizeConfiguration({
      html_handling: "none",
      base_path: "/subpath/",
    });
    // The asset is stored asset-relative at /foo, NOT /subpath/foo.
    const exists = vi.fn((pathname: string) => (pathname === "/foo" ? "etag-foo" : null));
    const getByETag = mockGetByETag();

    const response = await handleRequest(
      new Request("https://example.com/subpath/foo"),
      // @ts-expect-error Empty config default to using mocked jaeger
      mockEnv,
      configuration,
      exists,
      getByETag,
      analytics,
    );

    expect(response.status).toBe(200);
    expect(exists).toHaveBeenCalledWith("/foo", expect.anything());
  });

  it("applies base_path to requests made through the asset worker entrypoint", async ({
    expect,
  }) => {
    const worker = new AssetWorkerInner(createExecutionContext(), {
      CONFIG: {
        base_path: "/subpath/",
        html_handling: "none",
      },
    } as Env);
    vi.spyOn(worker, "unstable_exists").mockImplementation(async (pathname) =>
      pathname === "/foo" ? "etag-foo" : null,
    );
    vi.spyOn(worker, "unstable_getByETag").mockResolvedValue({
      readableStream: new ReadableStream(),
      contentType: "text/plain",
      cacheStatus: "HIT",
    });

    const inPrefixResponse = await worker.fetch(new Request("https://example.com/subpath/foo"));
    expect(inPrefixResponse.status).toBe(200);

    const offPrefixResponse = await worker.fetch(new Request("https://example.com/foo"));
    expect(offPrefixResponse.status).toBe(404);
  });

  it.for([
    {
      publicPath: "/subpath//foo",
      assetPath: "/foo",
      location: "/subpath/foo",
    },
    {
      publicPath: "/subpath%2Ffoo",
      assetPath: "/foo",
      location: "/subpath/foo",
    },
    {
      publicPath: "/subpath/%ZZ",
      assetPath: "/%ZZ",
      location: "/subpath/%25ZZ",
    },
    {
      publicPath: "/subpath/%FF",
      assetPath: "/%FF",
      location: "/subpath/%25FF",
    },
  ])(
    "canonicalizes $publicPath once before prefix lookup",
    async ({ publicPath, assetPath, location }, { expect }) => {
      const configuration = normalizeConfiguration({
        html_handling: "none",
        base_path: "/subpath/",
      });
      const exists = vi.fn((pathname: string) => (pathname === assetPath ? "etag" : null));

      const response = await handleRequest(
        new Request(`https://example.com${publicPath}`),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        mockGetByETag(),
        analytics,
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("Location")).toBe(location);
      expect(exists).toHaveBeenCalledWith(assetPath, expect.anything());
    },
  );

  it("returns NoIntent for an off-prefix request", async ({ expect }) => {
    const configuration = normalizeConfiguration({
      html_handling: "none",
      base_path: "/subpath/",
    });
    const exists = vi.fn(() => "etag");

    expect(
      await canFetch(
        new Request("https://example.com/other"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
      ),
    ).toBe(false);
  });

  it("is segment-aware: /subpath-other is off-prefix", async ({ expect }) => {
    const configuration = normalizeConfiguration({
      html_handling: "none",
      base_path: "/subpath/",
    });
    const exists = vi.fn(() => "etag");

    expect(
      await canFetch(
        new Request("https://example.com/subpath-other/foo"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
      ),
    ).toBe(false);
  });

  it("re-prefixes a generated HTML redirect location", async ({ expect }) => {
    const configuration = normalizeConfiguration({
      html_handling: "auto-trailing-slash",
      base_path: "/subpath/",
    });
    // /foo/index.html exists so /subpath/foo should redirect to /subpath/foo/.
    const exists = vi.fn((pathname: string) =>
      pathname === "/foo/index.html" ? "etag-index" : null,
    );
    const getByETag = mockGetByETag();

    const response = await handleRequest(
      new Request("https://example.com/subpath/foo"),
      // @ts-expect-error Empty config default to using mocked jaeger
      mockEnv,
      configuration,
      exists,
      getByETag,
      analytics,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/subpath/foo/");
  });

  it("preserves the query string on a generated redirect", async ({ expect }) => {
    const configuration = normalizeConfiguration({
      html_handling: "auto-trailing-slash",
      base_path: "/subpath/",
    });
    const exists = vi.fn((pathname: string) =>
      pathname === "/foo/index.html" ? "etag-index" : null,
    );
    const getByETag = mockGetByETag();

    const response = await handleRequest(
      new Request("https://example.com/subpath/foo?a=1"),
      // @ts-expect-error Empty config default to using mocked jaeger
      mockEnv,
      configuration,
      exists,
      getByETag,
      analytics,
    );

    expect(response.headers.get("Location")).toBe("/subpath/foo/?a=1");
  });

  it("resolves an in-prefix SPA fallback to the asset-directory index", async ({ expect }) => {
    const configuration = normalizeConfiguration({
      html_handling: "none",
      not_found_handling: "single-page-application",
      base_path: "/subpath/",
    });
    const exists = vi.fn((pathname: string) => (pathname === "/index.html" ? "etag-index" : null));
    const getByETag = mockGetByETag();

    const response = await handleRequest(
      new Request("https://example.com/subpath/missing"),
      // @ts-expect-error Empty config default to using mocked jaeger
      mockEnv,
      configuration,
      exists,
      getByETag,
      analytics,
    );

    expect(response.status).toBe(200);
    expect(exists).toHaveBeenCalledWith("/index.html", expect.anything());
  });

  it("accepts an authored 200 rewrite with an in-prefix public target", async ({ expect }) => {
    const configuration = normalizeConfiguration({
      base_path: "/subpath/",
      html_handling: "none",
      redirects: {
        version: 1,
        staticRules: {
          "/subpath/example": {
            status: 200,
            to: "/subpath/foo",
            lineNumber: 1,
          },
        },
        rules: {},
      },
    });
    const exists = vi.fn((pathname: string) => (pathname === "/foo" ? "etag-foo" : null));

    expect(
      await canFetch(
        new Request("https://example.com/subpath/example"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
      ),
    ).toBe(true);
    expect(exists).toHaveBeenCalledWith("/foo", expect.anything());
  });

  it("claims an authored 200 rewrite whose target is off-prefix", async ({ expect }) => {
    const configuration = normalizeConfiguration({
      base_path: "/subpath/",
      html_handling: "none",
      redirects: {
        version: 1,
        staticRules: {
          "/subpath/example": {
            status: 200,
            to: "/foo",
            lineNumber: 1,
          },
        },
        rules: {},
      },
    });
    const exists = vi.fn((pathname: string) => (pathname === "/foo" ? "etag-foo" : null));
    expect(
      await canFetch(
        new Request("https://example.com/subpath/example"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
      ),
    ).toBe(true);
    expect(exists).not.toHaveBeenCalled();

    const response = await handleRequest(
      new Request("https://example.com/subpath/example"),
      // @ts-expect-error Empty config default to using mocked jaeger
      mockEnv,
      configuration,
      exists,
      mockGetByETag(),
      analytics,
    );
    expect(response.status).toBe(404);
    expect(exists).not.toHaveBeenCalled();
  });

  it("ignores an authored 200 rewrite from an off-prefix source", async ({ expect }) => {
    const configuration = normalizeConfiguration({
      base_path: "/subpath/",
      html_handling: "none",
      redirects: {
        version: 1,
        staticRules: {
          "/other": {
            status: 200,
            to: "/subpath/foo",
            lineNumber: 1,
          },
        },
        rules: {},
      },
    });
    const exists = vi.fn((pathname: string) => (pathname === "/foo" ? "etag-foo" : null));

    expect(
      await canFetch(
        new Request("https://example.com/other"),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
      ),
    ).toBe(false);
    expect(exists).not.toHaveBeenCalled();
  });

  it("ignores an off-prefix authored non-200 redirect", async ({ expect }) => {
    const configuration = normalizeConfiguration({
      base_path: "/subpath/",
      html_handling: "none",
      redirects: {
        version: 1,
        staticRules: {
          "/other": {
            status: 301,
            to: "/somewhere",
            lineNumber: 1,
          },
        },
        rules: {},
      },
    });
    const exists = vi.fn(() => null);
    const getByETag = mockGetByETag();

    const response = await handleRequest(
      new Request("https://example.com/other"),
      // @ts-expect-error Empty config default to using mocked jaeger
      mockEnv,
      configuration,
      exists,
      getByETag,
      analytics,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("returns an in-prefix authored redirect before decoding a malformed pathname", async ({
    expect,
  }) => {
    const configuration = normalizeConfiguration({
      base_path: "/subpath/",
      html_handling: "none",
      redirects: {
        version: 1,
        staticRules: {
          "/subpath/%ZZ": {
            status: 301,
            to: "/authored-destination",
            lineNumber: 1,
          },
        },
        rules: {},
      },
    });
    const exists = vi.fn(() => null);

    const response = await handleRequest(
      new Request("https://example.com/subpath/%ZZ"),
      // @ts-expect-error Empty config default to using mocked jaeger
      mockEnv,
      configuration,
      exists,
      mockGetByETag(),
      analytics,
    );

    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe("/authored-destination");
    expect(exists).not.toHaveBeenCalled();
  });

  it("does not attach custom headers to an off-prefix response", async ({ expect }) => {
    const configuration = normalizeConfiguration({
      base_path: "/subpath/",
      html_handling: "none",
      headers: {
        version: 2,
        rules: {
          "/other": {
            set: { "X-Custom-Header": "value" },
          },
        },
      },
    });

    const response = await handleRequest(
      new Request("https://example.com/other"),
      // @ts-expect-error Empty config default to using mocked jaeger
      mockEnv,
      configuration,
      vi.fn(() => null),
      mockGetByETag(),
      analytics,
    );

    expect(response.headers.get("X-Custom-Header")).toBeNull();
  });

  it("matches custom headers against the public base path", async ({ expect }) => {
    const configuration = normalizeConfiguration({
      base_path: "/subpath/",
      html_handling: "none",
      headers: {
        version: 2,
        rules: {
          "/subpath/*": {
            set: { "X-Base-Path": "matched" },
          },
        },
      },
    });
    const exists = vi.fn((pathname: string) => (pathname === "/foo" ? "etag-foo" : null));

    const inPrefixResponse = await handleRequest(
      new Request("https://example.com/subpath/foo"),
      // @ts-expect-error Empty config default to using mocked jaeger
      mockEnv,
      configuration,
      exists,
      mockGetByETag(),
      analytics,
    );
    expect(inPrefixResponse.status).toBe(200);
    expect(inPrefixResponse.headers.get("X-Base-Path")).toBe("matched");

    const offPrefixResponse = await handleRequest(
      new Request("https://example.com/foo"),
      // @ts-expect-error Empty config default to using mocked jaeger
      mockEnv,
      configuration,
      exists,
      mockGetByETag(),
      analytics,
    );
    expect(offPrefixResponse.status).toBe(404);
    expect(offPrefixResponse.headers.get("X-Base-Path")).toBeNull();
  });

  it("redirects the base root to a trailing slash under force-trailing-slash", async ({
    expect,
  }) => {
    const configuration = normalizeConfiguration({
      html_handling: "force-trailing-slash",
      base_path: "/subpath/",
    });
    const exists = vi.fn((pathname: string) => (pathname === "/index.html" ? "etag-index" : null));
    const getByETag = mockGetByETag();

    const response = await handleRequest(
      new Request("https://example.com/subpath"),
      // @ts-expect-error Empty config default to using mocked jaeger
      mockEnv,
      configuration,
      exists,
      getByETag,
      analytics,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/subpath/");
  });

  it("redirects the base root under auto-trailing-slash and preserves the query", async ({
    expect,
  }) => {
    const configuration = normalizeConfiguration({
      html_handling: "auto-trailing-slash",
      base_path: "/subpath/",
    });
    const exists = vi.fn((pathname: string) => (pathname === "/index.html" ? "etag-index" : null));

    const response = await handleRequest(
      new Request("https://example.com/subpath?q=1"),
      // @ts-expect-error Empty config default to using mocked jaeger
      mockEnv,
      configuration,
      exists,
      mockGetByETag(),
      analytics,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/subpath/?q=1");
  });

  it("redirects the slash base root under drop-trailing-slash", async ({ expect }) => {
    const configuration = normalizeConfiguration({
      html_handling: "drop-trailing-slash",
      base_path: "/subpath/",
    });
    const exists = vi.fn((pathname: string) => (pathname === "/index.html" ? "etag-index" : null));

    const response = await handleRequest(
      new Request("https://example.com/subpath/?q=1"),
      // @ts-expect-error Empty config default to using mocked jaeger
      mockEnv,
      configuration,
      exists,
      mockGetByETag(),
      analytics,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/subpath?q=1");
  });

  it("does not generate a base-root redirect under html_handling none", async ({ expect }) => {
    const configuration = normalizeConfiguration({
      html_handling: "none",
      base_path: "/subpath/",
    });

    for (const pathname of ["/subpath", "/subpath/"]) {
      const response = await handleRequest(
        new Request(`https://example.com${pathname}`),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        vi.fn((assetPath: string) => (assetPath === "/index.html" ? "etag-index" : null)),
        mockGetByETag(),
        analytics,
      );
      expect(response.headers.get("Location")).toBeNull();
    }
  });

  it("gives an authored redirect precedence at the base root", async ({ expect }) => {
    const configuration = normalizeConfiguration({
      html_handling: "force-trailing-slash",
      base_path: "/subpath/",
      redirects: {
        version: 1,
        staticRules: {
          "/subpath": { status: 302, to: "/authored", lineNumber: 1 },
        },
        rules: {},
      },
    });

    const response = await handleRequest(
      new Request("https://example.com/subpath"),
      // @ts-expect-error Empty config default to using mocked jaeger
      mockEnv,
      configuration,
      vi.fn(() => "etag-index"),
      mockGetByETag(),
      analytics,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/authored");
  });

  it("does not redirect a base root without an index asset", async ({ expect }) => {
    const configuration = normalizeConfiguration({
      html_handling: "force-trailing-slash",
      base_path: "/subpath/",
    });

    const response = await handleRequest(
      new Request("https://example.com/subpath"),
      // @ts-expect-error Empty config default to using mocked jaeger
      mockEnv,
      configuration,
      vi.fn(() => null),
      mockGetByETag(),
      analytics,
    );

    expect(response.headers.get("Location")).toBeNull();
  });

  it("does not generate a slash redirect for a non-index root asset", async ({ expect }) => {
    const configuration = normalizeConfiguration({
      html_handling: "force-trailing-slash",
      base_path: "/subpath/",
    });

    const response = await handleRequest(
      new Request("https://example.com/subpath"),
      // @ts-expect-error Empty config default to using mocked jaeger
      mockEnv,
      configuration,
      vi.fn((pathname: string) => (pathname === "/" ? "etag-root" : null)),
      mockGetByETag(),
      analytics,
    );

    expect(response.headers.get("Location")).toBeNull();
  });

  it("percent-encodes a Unicode base-root redirect", async ({ expect }) => {
    const configuration = normalizeConfiguration({
      html_handling: "force-trailing-slash",
      base_path: "/路径/",
    });
    const exists = vi.fn((pathname: string) => (pathname === "/index.html" ? "etag-index" : null));

    const response = await handleRequest(
      new Request("https://example.com/%E8%B7%AF%E5%BE%84"),
      // @ts-expect-error Empty config default to using mocked jaeger
      mockEnv,
      configuration,
      exists,
      mockGetByETag(),
      analytics,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/%E8%B7%AF%E5%BE%84/");
  });

  for (const html_handling of ["auto-trailing-slash", "force-trailing-slash"] as const) {
    it(`returns 405 for POST at the base root under ${html_handling}`, async ({ expect }) => {
      const configuration = normalizeConfiguration({
        html_handling,
        base_path: "/subpath/",
      });
      const exists = vi.fn((pathname: string) =>
        pathname === "/index.html" ? "etag-index" : null,
      );

      const response = await handleRequest(
        new Request("https://example.com/subpath", { method: "POST" }),
        // @ts-expect-error Empty config default to using mocked jaeger
        mockEnv,
        configuration,
        exists,
        mockGetByETag(),
        analytics,
      );

      expect(response.status).toBe(405);
      expect(response.headers.get("Location")).toBeNull();
    });
  }

  it("allows HEAD to use the base-root redirect", async ({ expect }) => {
    const configuration = normalizeConfiguration({
      html_handling: "auto-trailing-slash",
      base_path: "/subpath/",
    });
    const exists = vi.fn((pathname: string) => (pathname === "/index.html" ? "etag-index" : null));

    const response = await handleRequest(
      new Request("https://example.com/subpath", { method: "HEAD" }),
      // @ts-expect-error Empty config default to using mocked jaeger
      mockEnv,
      configuration,
      exists,
      mockGetByETag(),
      analytics,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/subpath/");
  });

  it("keeps the public pathname in request-facing telemetry", async ({ expect }) => {
    const configuration = normalizeConfiguration({
      html_handling: "auto-trailing-slash",
      base_path: "/subpath/",
    });
    const exists = vi.fn((pathname: string) => (pathname === "/foo.html" ? "etag-foo" : null));
    const { binding, spans } = recordingJaegerBinding();

    await handleRequest(
      new Request("https://example.com/subpath/foo"),
      // @ts-expect-error Only the Jaeger binding is needed by the handler
      { JAEGER: binding },
      configuration,
      exists,
      mockGetByETag(),
      analytics,
    );

    expect(spans.get("getByETag")).toMatchObject({
      pathname: "/subpath/foo",
      eTag: "etag-foo",
    });
  });

  it("leaves getIntent asset-relative (does not strip base_path)", async ({ expect }) => {
    const configuration = normalizeConfiguration({
      html_handling: "none",
      base_path: "/subpath/",
    });
    const exists = vi.fn(async (pathname: string) => (pathname === "/foo" ? "etag-foo" : null));

    // getIntent receives already-stripped asset-relative paths.
    const intent = await getIntent(
      "/foo",
      new Request("https://example.com/subpath/foo"),
      configuration,
      exists,
    );
    expect(intent?.asset?.eTag).toBe("etag-foo");
  });
});
