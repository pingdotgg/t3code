// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off - a real loopback client and fake upstream exercise the byte stream.
import * as NodeHttp from "node:http";
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
              response.writeHead(429, { "content-encoding": "gzip" });
              response.end(
                NodeZlib.gzipSync(
                  '{"type":"error","error":{"type":"rate_limit_error","message":"Error"}}',
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
          onRewrite: (rules) => Effect.sync(() => rewrites.push(rules)),
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

        const failed = yield* Effect.promise(() => post("/v1/messages?fail=1"));
        assert.strictEqual(failed.status, 429);
        yield* Effect.promise(() => failed.arrayBuffer());
        assert.deepEqual(
          failures.map((failure) => [failure.status, failure.errorType, failure.errorMessage]),
          [[429, "rate_limit_error", "Error"]],
        );

        // Requests outside a live route never reach the upstream.
        const origin = new URL(route.baseUrl).origin;
        for (const path of [`/s/${"a".repeat(43)}/v1/messages`, "/v1/messages"]) {
          const stray = yield* Effect.promise(() =>
            fetch(`${origin}${path}`, { method: "POST", body: requestBody }),
          );
          assert.strictEqual(stray.status, 404);
        }
        assert.strictEqual(upstream.received.length, 2);
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
});
