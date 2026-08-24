import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
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

const electronProtocolLayer = ElectronProtocol.layer.pipe(Layer.provide(NodeServices.layer));
const fileProtocolTestLayer = Layer.merge(NodeServices.layer, electronProtocolLayer);

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
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            backendOrigin: new URL("http://127.0.0.1:3774/"),
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
            "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://clerk.t3.codes https://challenges.cloudflare.com",
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
    }).pipe(Effect.provide(electronProtocolLayer)),
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
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            backendOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: undefined,
          });
          return yield* Effect.promise(() => handler!(new Request("t3code://other/")));
        }),
      );

      assert.equal(response.status, 404);
      assert.equal(netFetchMock.mock.calls.length, 0);
    }).pipe(Effect.provide(electronProtocolLayer)),
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
            targetOrigin: new URL("http://127.0.0.1:5733/"),
            backendOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: undefined,
          });
          return yield* Effect.promise(() => handler!(new Request("t3code-dev://app/")));
        }),
      );

      assert.equal(yield* Effect.promise(() => response.text()), "ready");
      assert.equal(netFetchMock.mock.calls.length, 2);
    }).pipe(Effect.provide(electronProtocolLayer)),
  );

  it.effect("serves packaged renderer assets with SPA fallback", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rendererRootPath = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-renderer-test-",
      });
      const assetsPath = path.join(rendererRootPath, "assets");
      const assetPath = path.join(assetsPath, "app.js");
      const indexPath = path.join(rendererRootPath, "index.html");
      yield* fileSystem.makeDirectory(assetsPath);
      yield* fileSystem.writeFileString(assetPath, "export const ready = true;\n");
      yield* fileSystem.writeFileString(indexPath, "<!doctype html>\n");

      let handler = Option.none<(request: Request) => Promise<Response>>();
      handleMock.mockImplementation(
        (_scheme: string, nextHandler: (request: Request) => Promise<Response>) => {
          handler = Option.some(nextHandler);
        },
      );
      netFetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response("file", {
            headers: { "content-type": "application/javascript" },
          }),
        ),
      );

      const protocol = yield* ElectronProtocol.ElectronProtocol;
      yield* protocol.registerDesktopFileProtocol({
        scheme: "t3code",
        rendererRootPath,
        clerkFrontendApiHostname: undefined,
      });
      const registeredHandler = Option.getOrThrow(handler);

      const assetResponse = yield* Effect.promise(() =>
        registeredHandler(new Request("t3code://app/assets/app.js")),
      );
      const routeResponse = yield* Effect.promise(() =>
        registeredHandler(new Request("t3code://app/settings/connections")),
      );
      const assetUrl = yield* path.toFileUrl(assetPath);
      const indexUrl = yield* path.toFileUrl(indexPath);

      assert.equal(yield* Effect.promise(() => assetResponse.text()), "file");
      assert.equal(assetResponse.headers.get("content-type"), "application/javascript");
      assert.include(
        assetResponse.headers.get("content-security-policy") ?? "",
        "default-src 'self'",
      );
      assert.equal(yield* Effect.promise(() => routeResponse.text()), "file");
      assert.deepEqual(netFetchMock.mock.calls, [
        [assetUrl.href, { method: "GET" }],
        [indexUrl.href, { method: "GET" }],
      ]);
    }).pipe(Effect.scoped, Effect.provide(fileProtocolTestLayer)),
  );

  it.effect("rejects unsafe packaged renderer requests", () =>
    Effect.gen(function* () {
      let handler = Option.none<(request: Request) => Promise<Response>>();
      handleMock.mockImplementation(
        (_scheme: string, nextHandler: (request: Request) => Promise<Response>) => {
          handler = Option.some(nextHandler);
        },
      );
      netFetchMock.mockResolvedValue(new Response("unexpected"));

      const protocol = yield* ElectronProtocol.ElectronProtocol;
      yield* protocol.registerDesktopFileProtocol({
        scheme: "t3code",
        rendererRootPath: "/renderer",
        clerkFrontendApiHostname: undefined,
      });
      const registeredHandler = Option.getOrThrow(handler);

      const wrongHost = yield* Effect.promise(() =>
        registeredHandler(new Request("t3code://other/assets/app.js")),
      );
      const unsupportedMethod = yield* Effect.promise(() =>
        registeredHandler(new Request("t3code://app/assets/app.js", { method: "POST" })),
      );
      const traversal = yield* Effect.promise(() =>
        registeredHandler(new Request("t3code://app/%2e%2e%2foutside.txt")),
      );
      const malformedPath = yield* Effect.promise(() =>
        registeredHandler(new Request("t3code://app/%E0%A4%A")),
      );

      assert.equal(wrongHost.status, 404);
      assert.equal(unsupportedMethod.status, 405);
      assert.equal(traversal.status, 404);
      assert.equal(malformedPath.status, 404);
      assert.equal(netFetchMock.mock.calls.length, 0);
    }).pipe(Effect.scoped, Effect.provide(electronProtocolLayer)),
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
          targetOrigin: new URL("http://127.0.0.1:3773/"),
          backendOrigin: new URL("http://127.0.0.1:3774/"),
          clerkFrontendApiHostname: undefined,
        }),
      ).pipe(Effect.flip);

      assert.instanceOf(error, ElectronProtocol.ElectronProtocolRegistrationError);
      assert.equal(error.scheme, "t3code-dev");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message, 'Failed to register Electron protocol scheme "t3code-dev".');
    }).pipe(Effect.provide(electronProtocolLayer)),
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
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            backendOrigin: new URL("http://127.0.0.1:3773/"),
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
    }).pipe(Effect.provide(electronProtocolLayer)),
  );

  it("keeps executable sources host-restricted while allowing runtime network resources", () => {
    const policy = ElectronProtocol.makeDesktopContentSecurityPolicy({
      scheme: "t3code",
      targetOrigin: new URL("http://127.0.0.1:3773/"),
      backendOrigin: new URL("http://127.0.0.1:3773/"),
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
      "'wasm-unsafe-eval'",
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
});
