// @effect-diagnostics nodeBuiltinImport:off - a byte-for-byte streaming proxy needs raw Node sockets and headers.
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeStream from "node:stream";
import * as NodeZlib from "node:zlib";

import type {
  RequestRewriteRule,
  RequestRewriteRuleReport,
  RequestRulesDryRunInput,
  RequestRulesDryRunResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { isClaudeMessagesRequest, rewriteClaudeRequest } from "./claudeRequestRules.ts";

const DEFAULT_UPSTREAM = "https://api.anthropic.com";
// A long session's request carries its whole conversation; past this the dry run has none.
const MAX_KEPT_BODY_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_ERROR_MESSAGE = 500;
const ROUTE_PATH = /^\/s\/([A-Za-z0-9_-]{43})(\/.*)?$/;

export class ClaudeForwarderStartError extends Schema.TaggedError<ClaudeForwarderStartError>()(
  "ClaudeForwarderStartError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not start the local forwarder for Claude request rules.";
  }
}

/** A forwarded request that a rule changed and the provider refused. */
export interface ClaudeRewriteFailure {
  readonly status: number;
  readonly rules: ReadonlyArray<RequestRewriteRuleReport>;
  readonly errorType: string | undefined;
  readonly errorMessage: string | undefined;
}

export interface ClaudeForwarderRoute {
  /** What Claude Code should use as `ANTHROPIC_BASE_URL`. */
  readonly baseUrl: string;
  readonly setUpstream: (upstream: string | undefined) => Effect.Effect<void>;
}

interface Route {
  readonly threadId: ThreadId;
  upstream: URL;
  readonly rules: Effect.Effect<ReadonlyArray<RequestRewriteRule>>;
  readonly onRewrite: (rules: ReadonlyArray<RequestRewriteRuleReport>) => Effect.Effect<void>;
  readonly onFailure: (failure: ClaudeRewriteFailure) => Effect.Effect<void>;
  // The newest original messages request, held only in memory for the dry run.
  latest: { readonly path: string; readonly body: string; readonly sequence: number } | undefined;
}

const ProviderErrorBody = Schema.Struct({
  error: Schema.Struct({ type: Schema.String, message: Schema.String }),
});
const decodeProviderError = Schema.decodeUnknownOption(Schema.fromJsonString(ProviderErrorBody));

/** An http(s) base URL, or Anthropic's API when the value is missing or unusable. */
function upstreamUrl(value: string | undefined): URL {
  const url = URL.parse(value?.trim() ?? "");
  return url !== null && (url.protocol === "https:" || url.protocol === "http:")
    ? url
    : new URL(DEFAULT_UPSTREAM);
}

function decompress(body: Buffer, encoding: string | undefined): Buffer {
  switch (encoding) {
    case "gzip":
      return NodeZlib.gunzipSync(body);
    case "deflate":
      return NodeZlib.inflateSync(body);
    case "br":
      return NodeZlib.brotliDecompressSync(body);
    case "zstd":
      return NodeZlib.zstdDecompressSync(body);
    default:
      return body;
  }
}

function providerError(body: Buffer, encoding: string | undefined) {
  let text: string;
  try {
    text = decompress(body, encoding).toString("utf8");
  } catch {
    return undefined;
  }
  return Option.getOrUndefined(decodeProviderError(text))?.error;
}

const changedRules = (rules: ReadonlyArray<RequestRewriteRuleReport>) =>
  rules.filter((rule) => rule.blocks > 0);

/**
 * A loopback forwarder that applies the owner's request rules to what Claude Code sends. Each
 * session gets an unguessable path prefix; requests under any other path get 404. Headers go only
 * to the upstream and are never logged or kept.
 */
export class ClaudeRequestForwarder extends Context.Service<
  ClaudeRequestForwarder,
  {
    /**
     * Routes one session's requests until the scope closes, starting the listener on first use.
     * `rules` is read for every request.
     */
    readonly openRoute: (input: {
      readonly threadId: ThreadId;
      readonly upstream: string | undefined;
      readonly rules: Effect.Effect<ReadonlyArray<RequestRewriteRule>>;
      readonly onRewrite: (rules: ReadonlyArray<RequestRewriteRuleReport>) => Effect.Effect<void>;
      readonly onFailure: (failure: ClaudeRewriteFailure) => Effect.Effect<void>;
    }) => Effect.Effect<ClaudeForwarderRoute, ClaudeForwarderStartError, Scope.Scope>;
    /** Applies `rules` to the newest request of a live routed session, without sending it. */
    readonly dryRun: (input: RequestRulesDryRunInput) => Effect.Effect<RequestRulesDryRunResult>;
  }
>()("t3/provider/ClaudeRequestForwarder") {}

const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const layerScope = yield* Effect.scope;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const routes = new Map<string, Route>();
  const startLock = yield* Semaphore.make(1);
  let port: number | undefined;
  let sequence = 0;

  // Per request; the request owns its span through the session's turn.
  const forward = Effect.fnUntraced(function* (
    route: Route,
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
    path: string,
    original: Buffer,
  ) {
    const method = request.method ?? "GET";
    // An encoded body is not text this forwarder can read.
    const text =
      request.headers["content-encoding"] === undefined ? original.toString("utf8") : undefined;
    const messages = text !== undefined && isClaudeMessagesRequest(method, path);
    if (messages && original.length <= MAX_KEPT_BODY_BYTES) {
      sequence += 1;
      route.latest = { path, body: text, sequence };
    }
    const enabled = messages ? (yield* route.rules).filter((rule) => rule.enabled) : [];
    const rewrite =
      messages && enabled.length > 0
        ? rewriteClaudeRequest({ method, path, body: text, rules: enabled })
        : undefined;
    const changed = rewrite?.changed === true ? changedRules(rewrite.rules) : [];
    const body = rewrite?.changed === true ? Buffer.from(rewrite.body) : original;
    if (changed.length > 0) yield* route.onRewrite(changed);

    const target = new URL(route.upstream.pathname.replace(/\/$/, "") + path, route.upstream);
    const {
      host: _host,
      "content-length": _contentLength,
      "transfer-encoding": _transferEncoding,
      ...headers
    } = request.headers;
    const outcome = yield* Effect.callback<{
      readonly status: number;
      readonly errorBody?: Buffer;
      readonly encoding?: string;
    }>((resume) => {
      let settled = false;
      const settle = (value: { status: number; errorBody?: Buffer; encoding?: string }) => {
        if (settled) return;
        settled = true;
        resume(Effect.succeed(value));
      };
      const client = target.protocol === "https:" ? NodeHttps : NodeHttp;
      const upstream = client.request(
        target,
        {
          method,
          headers: {
            ...headers,
            ...(body.length > 0 || _contentLength !== undefined
              ? { "content-length": String(body.length) }
              : {}),
          },
        },
        (reply) => {
          // Node throws from these callbacks outside Effect; a throw here would stop the server.
          try {
            // Node's client accepts statuses its server side refuses to write, such as 099.
            const status = reply.statusCode ?? 502;
            if (status < 100 || status > 599) {
              reply.resume();
              response.writeHead(502).end();
              settle({ status: 502 });
              return;
            }
            response.writeHead(status, reply.headers);
            const keep = changed.length > 0 && (status < 200 || status >= 300);
            const kept: Array<Buffer> = [];
            let keptBytes = 0;
            if (keep) {
              reply.on("data", (chunk: Buffer) => {
                if (keptBytes >= MAX_ERROR_BODY_BYTES) return;
                kept.push(chunk);
                keptBytes += chunk.length;
              });
            }
            const encoding = reply.headers["content-encoding"];
            // Unlike pipe, pipeline destroys the response when the upstream fails mid-body, so
            // Claude Code sees the failure and retries as it would without the forwarder.
            NodeStream.pipeline(reply, response, () =>
              settle({
                status,
                ...(keep ? { errorBody: Buffer.concat(kept) } : {}),
                ...(encoding === undefined ? {} : { encoding }),
              }),
            );
          } catch {
            reply.destroy();
            response.destroy();
            settle({ status: 502 });
          }
        },
      );
      upstream.on("error", () => {
        if (response.headersSent) response.destroy();
        else response.writeHead(502).end();
        settle({ status: 502 });
      });
      // The client went away first; a finished response settles through the pipeline instead.
      response.on("close", () => {
        if (response.writableFinished) return;
        upstream.destroy();
        settle({ status: response.statusCode });
      });
      upstream.end(body);
      return Effect.sync(() => upstream.destroy());
    });
    if (changed.length === 0 || (outcome.status >= 200 && outcome.status < 300)) return;
    const error =
      outcome.errorBody === undefined
        ? undefined
        : providerError(outcome.errorBody, outcome.encoding);
    yield* route.onFailure({
      status: outcome.status,
      rules: changed,
      errorType: error?.type,
      errorMessage: error?.message.slice(0, MAX_ERROR_MESSAGE),
    });
  });

  const handle = (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    const match = ROUTE_PATH.exec(request.url ?? "");
    const route = match?.[1] === undefined ? undefined : routes.get(match[1]);
    if (route === undefined) {
      request.resume();
      response.writeHead(404).end();
      return;
    }
    const path = match?.[2] ?? "/";
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      runFork(
        forward(route, request, response, path, Buffer.concat(chunks)).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("claude-request-forwarder.request-failed", { cause }).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  if (!response.headersSent) response.writeHead(502).end();
                  else response.destroy();
                }),
              ),
            ),
          ),
        ),
      );
    });
  };

  const listen = Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<NodeHttp.Server>((resolve, reject) => {
          const server = NodeHttp.createServer(handle);
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => resolve(server));
        }),
      catch: (cause) => new ClaudeForwarderStartError({ cause }),
    }),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  ).pipe(
    Effect.flatMap((server) => {
      const address = server.address();
      return address === null || typeof address === "string"
        ? Effect.fail(new ClaudeForwarderStartError({ cause: "no port" }))
        : Effect.succeed(address.port);
    }),
    Scope.provide(layerScope),
  );

  const ensureListening = startLock.withPermits(1)(
    Effect.suspend(() =>
      port === undefined
        ? listen.pipe(
            Effect.tap((started) =>
              Effect.sync(() => {
                port = started;
              }),
            ),
          )
        : Effect.succeed(port),
    ),
  );

  const openRoute: ClaudeRequestForwarder["Service"]["openRoute"] = Effect.fn(
    "ClaudeRequestForwarder.openRoute",
  )(function* (input) {
    const listening = yield* ensureListening;
    const token = Base64Url.encode(yield* random.randomBytes(32));
    const route: Route = {
      threadId: input.threadId,
      upstream: upstreamUrl(input.upstream),
      rules: input.rules,
      onRewrite: input.onRewrite,
      onFailure: input.onFailure,
      latest: undefined,
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => routes.set(token, route)),
      () => Effect.sync(() => routes.delete(token)),
    );
    return {
      baseUrl: `http://127.0.0.1:${listening}/s/${token}`,
      setUpstream: (upstream) =>
        Effect.sync(() => {
          route.upstream = upstreamUrl(upstream);
        }),
    };
  });

  const dryRun: ClaudeRequestForwarder["Service"]["dryRun"] = (input) =>
    Effect.sync(() => {
      const recent = [...routes.values()]
        .flatMap((route) =>
          route.latest === undefined ? [] : [{ threadId: route.threadId, latest: route.latest }],
        )
        .toSorted((left, right) => right.latest.sequence - left.latest.sequence);
      const threadIds = [...new Set(recent.map((entry) => entry.threadId))];
      const chosen =
        input.threadId === undefined
          ? recent[0]
          : recent.find((entry) => entry.threadId === input.threadId);
      if (chosen === undefined) return { threadIds, rules: [] };
      const rewrite = rewriteClaudeRequest({
        method: "POST",
        path: chosen.latest.path,
        body: chosen.latest.body,
        rules: input.rules,
      });
      return {
        threadIds,
        threadId: chosen.threadId,
        ...(rewrite.skipped === undefined ? {} : { skipped: rewrite.skipped }),
        rules: rewrite.rules,
      };
    });

  return ClaudeRequestForwarder.of({ openRoute, dryRun });
});

export const layer = Layer.effect(ClaudeRequestForwarder, make);
