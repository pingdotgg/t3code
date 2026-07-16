// @effect-diagnostics nodeBuiltinImport:off -- tests stand up raw local Node
// servers to exercise the real pinned transport end-to-end.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import {
  HttpClientError,
  HttpEgressBlockedError,
  makeHttpClientCapability,
  type PluginHttpClientTransport,
} from "./HttpClientCapability.ts";

const encoder = new TextEncoder();

function responseFor(input: {
  readonly url: URL;
  readonly method: string;
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: string | Uint8Array | ArrayBuffer | null;
}) {
  const request = HttpClientRequest.make(input.method as "GET")(input.url.toString());
  return HttpClientResponse.fromWeb(
    request,
    new Response(input.body ?? "", {
      status: input.status ?? 200,
      headers: input.headers ?? {},
    }),
  );
}

function makeClient(input: {
  readonly lookup?: (host: string) => Effect.Effect<ReadonlyArray<string>, Error>;
  readonly transport?: PluginHttpClientTransport;
  readonly calls?: Array<{ readonly host: string; readonly address: string }>;
}) {
  return makeHttpClientCapability({
    lookup: input.lookup ?? (() => Effect.succeed(["140.82.112.3"])),
    transport:
      input.transport ??
      ((request) =>
        Effect.sync(() => {
          input.calls?.push({
            host: request.url.hostname,
            address: request.addresses[0]!.address,
          });
          return responseFor({
            url: request.url,
            method: request.method,
            headers: { "x-transport": "stub" },
            body: "ok",
          });
        })),
  });
}

describe("HttpClientCapability", () => {
  it.effect("rejects non-https and private egress before transport", () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const client = makeClient({
        lookup: () => Effect.succeed(["10.0.0.1"]),
        transport: () =>
          Effect.sync(() => {
            calls.push("transport");
            return responseFor({ url: new URL("https://never.test"), method: "GET" });
          }),
      });

      const httpError = yield* client
        .request({ method: "GET", url: "http://example.test" })
        .pipe(Effect.flip);
      const privateError = yield* client
        .request({ method: "GET", url: "https://internal.test" })
        .pipe(Effect.flip);

      assert.instanceOf(httpError, HttpEgressBlockedError);
      assert.instanceOf(privateError, HttpEgressBlockedError);
      assert.deepEqual(calls, []);
    }),
  );

  it.effect("pins the transport to the validated resolved address", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly host: string; readonly address: string }> = [];
      const client = makeClient({
        calls,
        lookup: () => Effect.succeed(["140.82.112.3", "140.82.113.4"]),
      });

      const result = yield* client.request({ method: "GET", url: "https://github.com/api" });

      assert.equal(result.status, 200);
      assert.equal(new TextDecoder().decode(result.body), "ok");
      assert.deepEqual(calls, [{ host: "github.com", address: "140.82.112.3" }]);
    }),
  );

  it.effect("rejects headers with control characters (CRLF injection) before transport", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly host: string; readonly address: string }> = [];
      const client = makeClient({ calls });

      const result = yield* Effect.exit(
        client.request({
          method: "GET",
          url: "https://github.com/api",
          headers: { "x-evil": "value\r\nx-injected: 1" },
        }),
      );

      assert.isTrue(result._tag === "Failure");
      assert.deepEqual(calls, []);
    }),
  );

  it.effect("rejects an oversized request body before transport", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly host: string; readonly address: string }> = [];
      const client = makeClient({ calls });

      const result = yield* Effect.exit(
        client.request({
          method: "POST",
          url: "https://github.com/api",
          body: new Uint8Array(33 * 1024 * 1024),
        }),
      );

      assert.isTrue(result._tag === "Failure");
      assert.deepEqual(calls, []);
    }),
  );

  it.effect("surfaces redirects without following them", () =>
    Effect.gen(function* () {
      const client = makeClient({
        transport: (request) =>
          Effect.succeed(
            responseFor({
              url: request.url,
              method: request.method,
              status: 302,
              headers: { location: "https://example.test/next" },
            }),
          ),
      });

      const result = yield* client.request({ method: "GET", url: "https://example.test/start" });

      assert.equal(result.status, 302);
      assert.equal(result.headers.location, "https://example.test/next");
    }),
  );

  it.effect("enforces response caps and maps timeout/transport failures", () =>
    Effect.gen(function* () {
      const tooLargeClient = makeClient({
        transport: (request) =>
          Effect.succeed(
            responseFor({
              url: request.url,
              method: request.method,
              body: encoder.encode("abcdef").buffer,
            }),
          ),
      });
      const timeoutClient = makeClient({
        transport: () =>
          Effect.fail(new HttpClientError({ host: "example.test", reason: "timeout" })),
      });

      const tooLarge = yield* tooLargeClient
        .request({
          method: "GET",
          url: "https://example.test/large",
          maxResponseBytes: 3,
        })
        .pipe(Effect.flip);
      const timeout = yield* timeoutClient
        .request({ method: "GET", url: "https://example.test/timeout", timeoutMs: 1 })
        .pipe(Effect.flip);

      assert.instanceOf(tooLarge, HttpClientError);
      assert.include(tooLarge.message, "example.test");
      assert.instanceOf(timeout, HttpClientError);
    }),
  );

  it.effect(
    "transport failures surface a stable reason that does not echo the underlying cause text",
    () =>
      Effect.gen(function* () {
        // Bind then immediately release a loopback port so a connect attempt is
        // deterministically refused, driving the real transport's catch branch.
        const port = yield* Effect.promise(
          () =>
            new Promise<number>((resolve) => {
              const server = NodeNet.createServer();
              server.listen(0, "127.0.0.1", () => {
                const address = server.address();
                const assigned = typeof address === "object" && address !== null ? address.port : 0;
                server.close(() => resolve(assigned));
              });
            }),
        );
        const previous = process.env.T3_PLUGIN_DEV;
        process.env.T3_PLUGIN_DEV = "1";
        try {
          // Call makeHttpClientCapability directly with NO transport so the real
          // nodePinnedTransport runs and its catch maps the connection failure into
          // an HttpClientError (makeClient injects a stub transport instead).
          const client = makeHttpClientCapability({ lookup: () => Effect.succeed(["127.0.0.1"]) });
          const error = yield* client
            .request({ method: "GET", url: `http://127.0.0.1:${port}/`, timeoutMs: 2000 })
            .pipe(Effect.flip);

          assert.instanceOf(error, HttpClientError);
          // The wrapper reason/message derive only from stable structural attributes;
          // they must NOT echo the underlying transport error text (e.g. ECONNREFUSED).
          assert.equal(error.reason, "transport request failed");
          assert.notInclude(error.message, "ECONNREFUSED");
          assert.notInclude(error.message, "connect");
        } finally {
          if (previous === undefined) {
            delete process.env.T3_PLUGIN_DEV;
          } else {
            process.env.T3_PLUGIN_DEV = previous;
          }
        }
      }),
  );

  it.live("enforces a wall-clock deadline against a slow-drip response", () =>
    Effect.gen(function* () {
      // The server sends headers then drips one byte per 50ms. Every byte
      // resets Node's socket-inactivity `timeout`, so without the end-to-end
      // deadline this request would stream forever below the byte cap.
      const server = NodeHttp.createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        // Raw Node timer on the test-server side, outside any Effect runtime.
        // @effect-diagnostics-next-line globalTimers:off
        const timer = setInterval(() => {
          response.write("x");
        }, 50);
        response.on("close", () => clearInterval(timer));
      });
      const port = yield* Effect.callback<number>((resume) => {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          resume(
            Effect.succeed(typeof address === "object" && address !== null ? address.port : 0),
          );
        });
      });
      const previous = process.env.T3_PLUGIN_DEV;
      process.env.T3_PLUGIN_DEV = "1";
      try {
        // Real nodePinnedTransport (no transport override) so the deadline is
        // proven against the actual socket, not a stub.
        const client = makeHttpClientCapability({ lookup: () => Effect.succeed(["127.0.0.1"]) });
        const error = yield* client
          .request({ method: "GET", url: `http://127.0.0.1:${port}/drip`, timeoutMs: 300 })
          .pipe(Effect.flip);

        assert.instanceOf(error, HttpClientError);
        assert.equal(error.reason, "request exceeded the time limit");
      } finally {
        if (previous === undefined) {
          delete process.env.T3_PLUGIN_DEV;
        } else {
          process.env.T3_PLUGIN_DEV = previous;
        }
        server.closeAllConnections();
        server.close();
      }
    }),
  );

  it.live("pins the real Node transport to the validated address, not system DNS", () =>
    Effect.gen(function* () {
      // `.invalid` never resolves through system DNS (RFC 2606): the request
      // can only reach the local server if the validator-resolved address is
      // pinned through the transport's `lookup` override.
      const requests: Array<string | undefined> = [];
      const server = NodeHttp.createServer((request, response) => {
        requests.push(request.headers.host);
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("pinned");
      });
      const port = yield* Effect.callback<number>((resume) => {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          resume(
            Effect.succeed(typeof address === "object" && address !== null ? address.port : 0),
          );
        });
      });
      const previous = process.env.T3_PLUGIN_DEV;
      process.env.T3_PLUGIN_DEV = "1";
      try {
        const client = makeHttpClientCapability({ lookup: () => Effect.succeed(["127.0.0.1"]) });
        const result = yield* client.request({
          method: "GET",
          url: `http://t3code-pin-test.invalid:${port}/`,
          timeoutMs: 2000,
        });

        assert.equal(result.status, 200);
        assert.equal(new TextDecoder().decode(result.body), "pinned");
        // The connection landed on the pinned loopback address while the
        // request kept the original hostname (Host header intact).
        assert.deepEqual(requests, [`t3code-pin-test.invalid:${port}`]);
      } finally {
        if (previous === undefined) {
          delete process.env.T3_PLUGIN_DEV;
        } else {
          process.env.T3_PLUGIN_DEV = previous;
        }
        server.closeAllConnections();
        server.close();
      }
    }),
  );

  // A real server and the real Node transport, deliberately: the crash lived in
  // `makeResponse` running inside Node's response callback, so a faked transport
  // would never reach it. Before the fix this did not fail the request — the
  // TypeError escaped the enclosing Promise and took the process down.
  it.live("returns a 204 rather than crashing on a null-body status", () =>
    Effect.gen(function* () {
      const server = NodeHttp.createServer((_request, response) => {
        response.writeHead(204);
        response.end();
      });
      const port = yield* Effect.callback<number>((resume) => {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          resume(
            Effect.succeed(typeof address === "object" && address !== null ? address.port : 0),
          );
        });
      });
      const previous = process.env.T3_PLUGIN_DEV;
      process.env.T3_PLUGIN_DEV = "1";
      try {
        const client = makeHttpClientCapability({ lookup: () => Effect.succeed(["127.0.0.1"]) });
        const result = yield* client.request({
          method: "GET",
          url: `http://127.0.0.1:${port}/`,
          timeoutMs: 2000,
        });

        assert.equal(result.status, 204);
        assert.equal(result.body.byteLength, 0);
      } finally {
        if (previous === undefined) {
          delete process.env.T3_PLUGIN_DEV;
        } else {
          process.env.T3_PLUGIN_DEV = previous;
        }
        server.closeAllConnections();
        server.close();
      }
    }),
  );

  it.effect("hands every validated address to the transport, not just the first", () =>
    Effect.gen(function* () {
      // The pinned transport gives these to Node's Happy Eyeballs, which falls back
      // when the first record is unreachable but a later one works. Pinning to
      // addresses[0] alone failed a reachable dual-stack host. All are validated by
      // the resolver — the resolve fails if ANY is disallowed — so handing the whole
      // set to the transport is exactly as safe as handing it one.
      const seen: Array<ReadonlyArray<string>> = [];
      const client = makeHttpClientCapability({
        // A dead IPv6 first, a working IPv4 second — both public, both validated.
        lookup: () => Effect.succeed(["2606:4700:4700::1111", "140.82.112.3"]),
        transport: (request) =>
          Effect.sync(() => {
            seen.push(request.addresses.map((address) => address.address));
            return responseFor({
              url: request.url,
              method: request.method,
              headers: {},
              body: "ok",
            });
          }),
      });

      yield* client.request({ method: "GET", url: "https://example.test/", timeoutMs: 1000 });

      assert.deepEqual(seen, [["2606:4700:4700::1111", "140.82.112.3"]]);
    }),
  );

  it.effect("allows http loopback only under T3_PLUGIN_DEV", () =>
    Effect.gen(function* () {
      const previous = process.env.T3_PLUGIN_DEV;
      const client = makeClient({ lookup: () => Effect.succeed(["127.0.0.1"]) });
      try {
        delete process.env.T3_PLUGIN_DEV;
        assert.instanceOf(
          yield* client.request({ method: "GET", url: "http://localhost:5173" }).pipe(Effect.flip),
          HttpEgressBlockedError,
        );
        process.env.T3_PLUGIN_DEV = "1";
        const result = yield* client.request({ method: "GET", url: "http://localhost:5173" });
        assert.equal(result.status, 200);
      } finally {
        if (previous === undefined) {
          delete process.env.T3_PLUGIN_DEV;
        } else {
          process.env.T3_PLUGIN_DEV = previous;
        }
      }
    }),
  );
});
