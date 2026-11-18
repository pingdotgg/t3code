// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off - a real loopback client and fake upstream exercise the byte stream.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeZlib from "node:zlib";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import { ThreadId, type RequestRewriteRuleReport } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

import * as ClaudeRequestForwarder from "./ClaudeRequestForwarder.ts";

const SECRET = "Bearer secret-login-token";

interface Received {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}

/** A local stand-in for the provider: streams SSE in two parts and fails `?fail` requests. */
const fakeUpstream = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{
        readonly server: NodeHttp.Server;
        readonly received: Array<Received>;
        readonly release: () => void;
      }>((resolve) => {
        const received: Array<Received> = [];
        const second = Promise.withResolvers<void>();
        const server = NodeHttp.createServer((request, response) => {
          const chunks: Array<Buffer> = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            received.push({
              method: request.method,
              url: request.url,
              headers: request.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            });
            if (request.url?.includes("fail") === true) {
              // An upstream that echoes the caller's credentials back in its error message.
              const message = request.url.includes("echo")
                ? `Bad ${request.headers.authorization} (${SECRET.slice("Bearer ".length)})`
                : "Error";
              response.writeHead(429, { "content-encoding": "gzip" });
              response.end(
                NodeZlib.gzipSync(
                  JSON.stringify({ type: "error", error: { type: "rate_limit_error", message } }),
                ),
              );
              return;
            }
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write("event: message_start\n\n");
            void second.promise.then(() => response.end("event: message_stop\n\n"));
          });
        });
        server.listen(0, "127.0.0.1", () =>
          resolve({ server, received, release: () => second.resolve() }),
        );
      }),
  ),
  ({ server }) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
);

const requestBody = JSON.stringify({
  system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=1;" }],
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "<system-reminder>drop me</system-reminder>" },
        { type: "text", text: "hello" },
      ],
    },
  ],
});

describe("ClaudeRequestForwarder", () => {
  it.live(
    "rewrites, streams and fails through a session's route, and nothing else gets through",
    () => {
      const logs: Array<string> = [];
      const logger = Logger.make(({ message }) => {
        logs.push(JSON.stringify(message));
      });
      return Effect.gen(function* () {
        const upstream = yield* fakeUpstream;
        const address = upstream.server.address();
        assert.isTrue(address !== null && typeof address === "object");
        const upstreamPort = address !== null && typeof address === "object" ? address.port : 0;
        const rewrites: Array<ReadonlyArray<RequestRewriteRuleReport>> = [];
        const failures: Array<ClaudeRequestForwarder.ClaudeRewriteFailure> = [];
        const forwarder = yield* ClaudeRequestForwarder.ClaudeRequestForwarder;
        const route = yield* forwarder.openRoute({
          threadId: ThreadId.make("thread-forwarder"),
          upstream: `http://127.0.0.1:${upstreamPort}/gateway/`,
          rules: Effect.succeed([
            {
              id: "drop-reminders",
              name: "Drop reminders",
              enabled: true,
              action: "remove",
              target: "reminders",
              pattern: "[\\s\\S]*",
            },
          ]),
          onRewrite: (rewrite) => Effect.sync(() => rewrites.push(rewrite.rules)),
          onFailure: (failure) => Effect.sync(() => failures.push(failure)),
        });
        assert.match(route.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/s\/[A-Za-z0-9_-]{43}$/);
        const post = (path: string) =>
          fetch(`${route.baseUrl}${path}`, {
            method: "POST",
            headers: { authorization: SECRET, "content-type": "application/json" },
            body: requestBody,
          });

        const response = yield* Effect.promise(() => post("/v1/messages?beta=true"));
        assert.strictEqual(response.status, 200);
        const reader = response.body?.getReader();
        assert.isDefined(reader);
        const decoder = new TextDecoder();
        // The first event arrives while the upstream still holds the stream open.
        const first = yield* Effect.promise(async () => (await reader?.read())?.value);
        assert.strictEqual(decoder.decode(first), "event: message_start\n\n");
        upstream.release();
        let rest = "";
        for (;;) {
          const chunk = yield* Effect.promise(async () => reader?.read());
          if (chunk === undefined || chunk.done) break;
          rest += decoder.decode(chunk.value);
        }
        assert.strictEqual(rest, "event: message_stop\n\n");

        const sent = upstream.received[0];
        assert.strictEqual(sent?.url, "/gateway/v1/messages?beta=true");
        assert.strictEqual(sent?.headers.authorization, SECRET);
        assert.strictEqual(sent?.headers.host, `127.0.0.1:${upstreamPort}`);
        assert.deepEqual(JSON.parse(sent?.body ?? "{}").messages[0].content, [
          { type: "text", text: "hello" },
        ]);
        assert.strictEqual(sent?.headers["content-length"], String(sent?.body.length));
        assert.deepEqual(
          rewrites.map((rules) => rules.map((rule) => [rule.ruleId, rule.blocks])),
          [[["drop-reminders", 1]]],
        );

        // A dry run reads the session's newest original request, not what was sent.
        const dryRun = yield* forwarder.dryRun({
          rules: [
            {
              id: "keep",
              name: "Keep",
              enabled: false,
              action: "remove",
              target: "reminders",
              pattern: "drop ",
            },
          ],
        });
        assert.deepEqual(
          [dryRun.threadIds, dryRun.threadId, dryRun.rules.map((rule) => rule.removedChars)],
          [["thread-forwarder"], "thread-forwarder", [5]],
        );
        assert.deepEqual(
          (yield* forwarder.dryRun({ rules: [], threadId: ThreadId.make("other") })).threadId,
          undefined,
        );

        for (const path of ["/v1/messages?fail=1", "/v1/messages?fail=echo"]) {
          const failed = yield* Effect.promise(() => post(path));
          assert.strictEqual(failed.status, 429);
          yield* Effect.promise(() => failed.arrayBuffer());
        }
        assert.deepEqual(
          failures.map((failure) => [failure.status, failure.errorType, failure.errorMessage]),
          [
            [429, "rate_limit_error", "Error"],
            [429, "rate_limit_error", "Bad [redacted] ([redacted])"],
          ],
        );

        // An unreachable upstream answers 502 and logs only its error code and host.
        yield* route.setUpstream("http://127.0.0.1:1");
        const unreachable = yield* Effect.promise(() => post("/v1/messages"));
        assert.strictEqual(unreachable.status, 502);
        assert.isTrue(
          logs.some((line) => line.includes("ECONNREFUSED") && line.includes("127.0.0.1:1")),
        );

        // Requests outside a live route never reach the upstream.
        const origin = new URL(route.baseUrl).origin;
        for (const path of [`/s/${"a".repeat(43)}/v1/messages`, "/v1/messages"]) {
          const stray = yield* Effect.promise(() =>
            fetch(`${origin}${path}`, { method: "POST", body: requestBody }),
          );
          assert.strictEqual(stray.status, 404);
        }
        assert.strictEqual(upstream.received.length, 3);
        assert.isFalse(logs.some((line) => line.includes("secret-login-token")));
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ClaudeRequestForwarder.layer.pipe(
            Layer.provide(NodeCrypto.layer),
            Layer.provide(Logger.layer([logger], { mergeWithExisting: false })),
          ),
        ),
      );
    },
  );

  it.live("answers 502 for a malformed status and fails a stream the upstream cuts off", () =>
    Effect.gen(function* () {
      const requestLines: Array<string> = [];
      // A raw socket upstream, so it can send what an HTTP server library refuses to.
      const rawServer = (respond: (socket: NodeNet.Socket, head: string) => void) =>
        Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<NodeNet.Server>((resolve) => {
                const server = NodeNet.createServer((socket) => {
                  socket.once("data", (chunk: Buffer) => respond(socket, chunk.toString("latin1")));
                });
                server.listen(0, "127.0.0.1", () => resolve(server));
              }),
          ),
          (server) =>
            Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
        );
      const portOf = (server: NodeNet.Server) => {
        const address = server.address();
        return address !== null && typeof address === "object" ? address.port : 0;
      };
      const decoyHits: Array<string> = [];
      const decoy = yield* rawServer((socket, head) => {
        decoyHits.push(head.split("\r\n")[0] ?? "");
        socket.end("HTTP/1.1 204 No Content\r\n\r\n");
      });
      const upstream = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<NodeNet.Server>((resolve) => {
              const server = NodeNet.createServer((socket) => {
                socket.once("data", (chunk: Buffer) => {
                  const head = chunk.toString("latin1");
                  requestLines.push(head.split("\r\n")[0] ?? "");
                  if (head.includes("hostcheck")) {
                    socket.end("HTTP/1.1 204 No Content\r\n\r\n");
                  } else if (head.includes("status099")) {
                    socket.end("HTTP/1.1 099 Odd\r\ncontent-length: 0\r\n\r\n");
                  } else {
                    socket.write(
                      "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5\r\nhello\r\n",
                    );
                    socket.end();
                  }
                });
              });
              server.listen(0, "127.0.0.1", () => resolve(server));
            }),
        ),
        (server) =>
          Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
      const address = upstream.address();
      const upstreamPort = address !== null && typeof address === "object" ? address.port : 0;
      const forwarder = yield* ClaudeRequestForwarder.ClaudeRequestForwarder;
      const route = yield* forwarder.openRoute({
        threadId: ThreadId.make("thread-raw-upstream"),
        upstream: `http://127.0.0.1:${upstreamPort}`,
        rules: Effect.succeed([]),
        onRewrite: () => Effect.void,
        onFailure: () => Effect.void,
      });

      const odd = yield* Effect.promise(() =>
        fetch(`${route.baseUrl}/v1/messages?status099`, { method: "POST", body: requestBody }),
      );
      assert.strictEqual(odd.status, 502);

      const cut = yield* Effect.promise(() =>
        fetch(`${route.baseUrl}/v1/messages?truncate`, { method: "POST", body: requestBody }),
      );
      assert.strictEqual(cut.status, 200);
      // The client sees the stream fail, as it would talking to the upstream directly.
      const read = yield* Effect.promise(() =>
        cut.text().then(
          () => "ended",
          () => "failed",
        ),
      );
      assert.strictEqual(read, "failed");

      // The request path never chooses the host, whatever it starts with.
      const token = new URL(route.baseUrl).pathname;
      const forwarderPort = Number(new URL(route.baseUrl).port);
      for (const prefix of ["//", "/\\"]) {
        const status = yield* Effect.promise(
          () =>
            new Promise<number | undefined>((resolve, reject) => {
              const request = NodeHttp.request(
                {
                  host: "127.0.0.1",
                  port: forwarderPort,
                  method: "POST",
                  path: `${token}${prefix}127.0.0.1:${portOf(decoy)}/hostcheck`,
                },
                (response) => {
                  response.resume();
                  response.on("end", () => resolve(response.statusCode));
                },
              );
              request.on("error", reject);
              request.end(requestBody);
            }),
        );
        assert.strictEqual(status, 204);
      }
      assert.deepEqual(decoyHits, []);
      assert.deepEqual(requestLines.slice(-2), [
        `POST //127.0.0.1:${portOf(decoy)}/hostcheck HTTP/1.1`,
        `POST //127.0.0.1:${portOf(decoy)}/hostcheck HTTP/1.1`,
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(ClaudeRequestForwarder.layer.pipe(Layer.provide(NodeCrypto.layer))),
    ),
  );
});
