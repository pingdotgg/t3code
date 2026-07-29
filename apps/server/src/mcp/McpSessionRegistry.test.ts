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

const makeRegistry = (
  now: () => number,
  options: Pick<McpSessionRegistry.McpSessionRegistryOptions, "maximumLifetimeMs"> = {},
  hostname = "127.0.0.1",
) =>
  McpSessionRegistry.__testing
    .make({
      now,
      ...options,
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

    const explicit = yield* makeRegistry(() => 1_000, {}, "10.20.30.40");
    expect((yield* explicit.issue({ threadId, providerInstanceId })).config.endpoint).toBe(
      "http://10.20.30.40:43123/mcp",
    );

    const wildcard = yield* makeRegistry(() => 1_000, {}, "0.0.0.0");
    expect((yield* wildcard.issue({ threadId, providerInstanceId })).config.endpoint).toBe(
      "http://127.0.0.1:43123/mcp",
    );

    const ipv6 = yield* makeRegistry(() => 1_000, {}, "2001:db8::1");
    expect((yield* ipv6.issue({ threadId, providerInstanceId })).config.endpoint).toBe(
      "http://[2001:db8::1]:43123/mcp",
    );
  }),
);

it.effect(
  "stores only a token hash, resolves the bearer token, and revokes by provider session",
  () =>
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

      yield* registry.revokeProviderSession(issued.config.providerSessionId);
      expect(yield* registry.resolve(token)).toBeUndefined();

      timestamp += 2_000;
    }),
);

it.effect(
  "keeps credentials valid across the idle window while their provider session is alive",
  () =>
    Effect.gen(function* () {
      let timestamp = 1_000;
      const registry = yield* makeRegistry(() => timestamp);
      const issued = yield* registry.issue({
        threadId: ThreadId.make("thread-2"),
        providerInstanceId: ProviderInstanceId.make("claude"),
      });
      const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
      timestamp += 101;
      expect(yield* registry.resolve(token)).toMatchObject({
        threadId: ThreadId.make("thread-2"),
        providerSessionId: issued.config.providerSessionId,
      });

      yield* registry.revokeProviderSession(issued.config.providerSessionId);
      expect(yield* registry.resolve(token)).toBeUndefined();
    }),
);

it.effect("expires credentials after the maximum provider-session lifetime", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp, { maximumLifetimeMs: 100 });
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-expiry"),
      providerInstanceId: ProviderInstanceId.make("copilot"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
    expect(
      yield* registry.readProviderSession(
        ThreadId.make("thread-expiry"),
        ProviderInstanceId.make("copilot"),
      ),
    ).toBeUndefined();
  }),
);

it.effect("replaces only the credential for the restarted provider instance", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const threadId = ThreadId.make("thread-3");
      const first = yield* McpSessionRegistry.issueActiveMcpCredential({
        threadId,
        providerInstanceId: ProviderInstanceId.make("copilot"),
      });
      const second = yield* McpSessionRegistry.issueActiveMcpCredential({
        threadId,
        providerInstanceId: ProviderInstanceId.make("copilot"),
      });
      const other = yield* McpSessionRegistry.issueActiveMcpCredential({
        threadId,
        providerInstanceId: ProviderInstanceId.make("copilot-other"),
      });
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(other).toBeDefined();
      if (!first || !second || !other) {
        return;
      }

      const firstToken = first.config.authorizationHeader.replace(/^Bearer\s+/, "");
      const otherToken = other.config.authorizationHeader.replace(/^Bearer\s+/, "");
      expect(yield* registry.resolve(firstToken)).toBeUndefined();
      expect(yield* registry.resolve(otherToken)).toMatchObject({
        providerSessionId: other.config.providerSessionId,
      });
      expect(
        yield* registry.readProviderSession(threadId, ProviderInstanceId.make("copilot")),
      ).toBe(second.config);
      expect(
        yield* registry.readProviderSession(threadId, ProviderInstanceId.make("copilot-other")),
      ).toBe(other.config);
      expect(
        yield* registry.resolve(second.config.authorizationHeader.replace(/^Bearer\s+/, "")),
      ).toMatchObject({
        providerSessionId: second.config.providerSessionId,
      });

      yield* registry.revokeProviderInstance(threadId, ProviderInstanceId.make("copilot"));
      expect(
        yield* registry.resolve(second.config.authorizationHeader.replace(/^Bearer\s+/, "")),
      ).toBeUndefined();
      expect(yield* registry.resolve(otherToken)).toMatchObject({
        providerSessionId: other.config.providerSessionId,
      });
    }).pipe(
      Effect.provide(McpSessionRegistry.layer),
      Effect.provideService(HttpServer.HttpServer, makeFakeHttpServer("127.0.0.1")),
      Effect.provideService(ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    ),
  ),
);
