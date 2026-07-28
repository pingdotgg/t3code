import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: { _tag: "TcpAddress", hostname, port },
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (now: () => number, httpServer = fakeHttpServer) =>
  McpSessionRegistry.__testing
    .make({ now })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview", "orchestration"]),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token, registry.audience);
    expect(resolved?.threadId).toBe(threadId);
    expect(resolved?.capabilities).toEqual(new Set(["preview", "orchestration"]));
    expect(resolved?.audience).toBe(registry.audience);

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token, registry.audience)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["localhost", "http://localhost:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["preview"]),
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

it.effect("remains valid without wall-clock expiry and emits only audit-safe metadata", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const audit: Array<McpSessionRegistry.McpCredentialAuditEvent> = [];
    const registry = yield* McpSessionRegistry.__testing
      .make({ now: () => timestamp, audit: (event) => audit.push(event) })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provide(NodeServices.layer),
      );
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["orchestration"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const resolved = yield* registry.resolve(token, registry.audience);
    expect(resolved?.providerSessionId).toBe(issued.config.providerSessionId);
    expect(yield* registry.resolve(token, "urn:t3-code:mcp:other")).toBeUndefined();
    timestamp += 365 * 24 * 60 * 60 * 1_000;
    expect(yield* registry.resolve(token, registry.audience)).toEqual(resolved);
    expect(audit.map((event) => event.type)).toEqual([
      "issued",
      "resolved",
      "audience_denied",
      "resolved",
    ]);
    expect(audit.some((event) => Object.values(event).includes(token))).toBe(false);
  }),
);

it.effect("rotates a thread credential atomically and revokes the predecessor", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const request = {
      threadId: ThreadId.make("thread-rotate"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"] as const),
    };
    const first = yield* registry.issue(request);
    const second = yield* registry.rotate({
      ...request,
      capabilities: new Set(["preview", "orchestration"]),
    });
    const firstToken = first.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const secondToken = second.config.authorizationHeader.replace(/^Bearer\s+/, "");

    expect(yield* registry.resolve(firstToken, registry.audience)).toBeUndefined();
    expect((yield* registry.resolve(secondToken, registry.audience))?.capabilities).toEqual(
      new Set(["preview", "orchestration"]),
    );
  }),
);
