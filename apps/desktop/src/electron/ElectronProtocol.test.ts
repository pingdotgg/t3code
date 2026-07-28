import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const { handleMock, netFetchMock, unhandleMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  netFetchMock: vi.fn(),
  unhandleMock: vi.fn(),
}));

vi.mock("electron", () => ({
  net: { fetch: netFetchMock },
  protocol: { handle: handleMock, unhandle: unhandleMock },
}));

import * as ElectronProtocol from "./ElectronProtocol.ts";

describe("ElectronProtocol", () => {
  beforeEach(() => {
    handleMock.mockReset();
    netFetchMock.mockReset();
    unhandleMock.mockReset();
  });

  it.effect("proxies the stable renderer origin to the current app server", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock.mockResolvedValue(new Response("ok"));

      yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "t3code-dev",
            source: "proxy",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: "clerk.t3.codes",
          });
          assert.isDefined(handler);

          const response = yield* Effect.promise(() =>
            handler!(
              new Request("t3code-dev://app/api/health?verbose=1", {
                headers: {
                  accept: "application/json",
                  origin: "t3code-dev://app",
                  referer: "t3code-dev://app/",
                  "sec-fetch-site": "same-origin",
                },
              }),
            ),
          );
          assert.equal(yield* Effect.promise(() => response.text()), "ok");
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "script-src 'self' 'unsafe-inline' https://clerk.t3.codes https://challenges.cloudflare.com",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "connect-src 'self' http: https: ws: wss:",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "img-src 'self' t3code-dev: blob: data: http: https:",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "font-src 'self' t3code-dev: data:",
          );
        }),
      );

      assert.deepEqual(
        handleMock.mock.calls.map((call) => call[0]),
        ["t3code-dev"],
      );
      assert.equal(netFetchMock.mock.calls[0]?.[0], "http://127.0.0.1:3773/api/health?verbose=1");
      const forwardedHeaders = new Headers(netFetchMock.mock.calls[0]?.[1]?.headers);
      assert.equal(forwardedHeaders.get("accept"), "application/json");
      assert.isNull(forwardedHeaders.get("origin"));
      assert.isNull(forwardedHeaders.get("referer"));
      assert.isNull(forwardedHeaders.get("sec-fetch-site"));
      assert.deepEqual(unhandleMock.mock.calls, [["t3code-dev"]]);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("rejects custom protocol requests for another host", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "t3code",
            source: "proxy",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: undefined,
          });
          return yield* Effect.promise(() => handler!(new Request("t3code://other/")));
        }),
      );

      assert.equal(response.status, 404);
      assert.equal(netFetchMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("retries transient renderer target failures", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock
        .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:5733"))
        .mockResolvedValueOnce(new Response("ready"));

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "t3code-dev",
            source: "proxy",
            targetOrigin: new URL("http://127.0.0.1:5733/"),
            clerkFrontendApiHostname: undefined,
          });
          return yield* Effect.promise(() => handler!(new Request("t3code-dev://app/")));
        }),
      );

      assert.equal(yield* Effect.promise(() => response.text()), "ready");
      assert.equal(netFetchMock.mock.calls.length, 2);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("preserves protocol registration failures", () =>
    Effect.gen(function* () {
      const cause = new Error("protocol registration failed");
      handleMock.mockImplementationOnce(() => {
        throw cause;
      });

      const protocol = yield* ElectronProtocol.ElectronProtocol;
      const error = yield* Effect.scoped(
        protocol.registerDesktopProtocol({
          scheme: "t3code-dev",
          source: "proxy",
          targetOrigin: new URL("http://127.0.0.1:3773/"),
          clerkFrontendApiHostname: undefined,
        }),
      ).pipe(Effect.flip);

      assert.instanceOf(error, ElectronProtocol.ElectronProtocolRegistrationError);
      assert.equal(error.scheme, "t3code-dev");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message, 'Failed to register Electron protocol scheme "t3code-dev".');
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("preserves protocol unregistration failures", () =>
    Effect.gen(function* () {
      const cause = new Error("protocol unregistration failed");
      unhandleMock.mockImplementationOnce(() => {
        throw cause;
      });

      const protocol = yield* ElectronProtocol.ElectronProtocol;
      const exit = yield* Effect.exit(
        Effect.scoped(
          protocol.registerDesktopProtocol({
            scheme: "t3code",
            source: "proxy",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: undefined,
          }),
        ),
      );

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronProtocol.ElectronProtocolUnregistrationError);
        assert.equal(error.scheme, "t3code");
        assert.strictEqual(error.cause, cause);
        assert.equal(error.message, 'Failed to unregister Electron protocol scheme "t3code".');
      }
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it("keeps executable sources host-restricted while allowing runtime network resources", () => {
    const policy = ElectronProtocol.makeDesktopContentSecurityPolicy({
      scheme: "t3code",
      source: "proxy",
      targetOrigin: new URL("http://127.0.0.1:3773/"),
      clerkFrontendApiHostname: "clerk.t3.codes",
    });
    const directives = Object.fromEntries(
      policy.split("; ").map((directive) => {
        const [name, ...sources] = directive.split(" ");
        return [name, sources];
      }),
    );

    assert.deepEqual(directives["script-src"], [
      "'self'",
      "'unsafe-inline'",
      "https://clerk.t3.codes",
      "https://challenges.cloudflare.com",
    ]);
    assert.deepEqual(directives["connect-src"], ["'self'", "http:", "https:", "ws:", "wss:"]);
    assert.deepEqual(directives["img-src"], [
      "'self'",
      "t3code:",
      "blob:",
      "data:",
      "http:",
      "https:",
    ]);
    assert.deepEqual(directives["font-src"], ["'self'", "t3code:", "data:"]);
  });

  it.effect("serves packaged assets, SPA routes, HEAD requests, and CSP", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock.mockImplementation(async (url: string) => {
        if (url.endsWith("/index.html")) {
          return new Response("<main>T3 Code</main>", { status: 200 });
        }
        if (url.endsWith("/assets/app-123.js")) {
          return new Response("export {};", { status: 200 });
        }
        return new Response(null, { status: 404 });
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "t3code",
            source: "static",
            staticRoot: "/opt/t3/apps/server/dist/client",
            clerkFrontendApiHostname: undefined,
          });
          assert.isDefined(handler);

          const root = yield* Effect.promise(() =>
            handler!(
              new Request("t3code://app/", {
                headers: { accept: "text/html" },
              }),
            ),
          );
          assert.equal(root.status, 200);
          assert.equal(root.headers.get("content-type"), "text/html; charset=utf-8");
          assert.include(root.headers.get("content-security-policy") ?? "", "default-src 'self'");
          assert.equal(yield* Effect.promise(() => root.text()), "<main>T3 Code</main>");

          const asset = yield* Effect.promise(() =>
            handler!(new Request("t3code://app/assets/app-123.js")),
          );
          assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");
          assert.equal(yield* Effect.promise(() => asset.text()), "export {};");

          const route = yield* Effect.promise(() =>
            handler!(
              new Request("t3code://app/settings/connections", {
                headers: { accept: "text/html" },
              }),
            ),
          );
          assert.equal(route.status, 200);
          assert.equal(yield* Effect.promise(() => route.text()), "<main>T3 Code</main>");

          const head = yield* Effect.promise(() =>
            handler!(
              new Request("t3code://app/assets/app-123.js", {
                method: "HEAD",
              }),
            ),
          );
          assert.equal(head.status, 200);
          assert.equal(yield* Effect.promise(() => head.text()), "");
        }),
      );
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("does not fall back missing assets and rejects unsafe static requests", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock.mockResolvedValue(new Response(null, { status: 404 }));

      yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "t3code",
            source: "static",
            staticRoot: "/opt/t3/apps/server/dist/client",
            clerkFrontendApiHostname: undefined,
          });
          assert.isDefined(handler);

          const missingAsset = yield* Effect.promise(() =>
            handler!(
              new Request("t3code://app/assets/missing.js", {
                headers: { accept: "text/html" },
              }),
            ),
          );
          assert.equal(missingAsset.status, 404);
          assert.equal(netFetchMock.mock.calls.length, 1);

          const traversal = yield* Effect.promise(() =>
            handler!(new Request("t3code://app/%2e%2e%2fsecret.txt")),
          );
          assert.equal(traversal.status, 403);

          const unsupported = yield* Effect.promise(() =>
            handler!(new Request("t3code://app/", { method: "POST" })),
          );
          assert.equal(unsupported.status, 405);
          assert.equal(unsupported.headers.get("allow"), "GET, HEAD");
        }),
      );
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );
});
