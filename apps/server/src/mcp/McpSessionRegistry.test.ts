import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/unstable/http";

import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const makeFakeHttpServer = (hostname: string) =>
  HttpServer.HttpServer.of({
    address: { _tag: "TcpAddress", hostname, port: 43123 },
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeEnvironment = ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (now: () => number, hostname = "127.0.0.1") =>
  McpSessionRegistry.__testing
    .make({
      now,
      idleTimeoutMs: 100,
      maximumLifetimeMs: 1_000,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, makeFakeHttpServer(hostname)),
      Effect.provideService(ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

it.effect("advertises explicit bound hosts and normalizes wildcard and IPv6 hosts", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-host");
    const providerInstanceId = ProviderInstanceId.make("codex");

    const explicit = yield* makeRegistry(() => 1_000, "10.20.30.40");
    expect((yield* explicit.issue({ threadId, providerInstanceId })).config.endpoint).toBe(
      "http://10.20.30.40:43123/mcp",
    );

    const wildcard = yield* makeRegistry(() => 1_000, "0.0.0.0");
    expect((yield* wildcard.issue({ threadId, providerInstanceId })).config.endpoint).toBe(
      "http://127.0.0.1:43123/mcp",
    );

    const ipv6 = yield* makeRegistry(() => 1_000, "2001:db8::1");
    expect((yield* ipv6.issue({ threadId, providerInstanceId })).config.endpoint).toBe(
      "http://[2001:db8::1]:43123/mcp",
    );
  }),
);

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.threadId).toBe(threadId);

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("expires credentials after inactivity", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);
