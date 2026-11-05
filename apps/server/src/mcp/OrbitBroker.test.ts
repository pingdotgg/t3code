import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import { Operation, orbitCredentialPolicy } from "./orbitInput.ts";
import * as OrbitBroker from "./OrbitBroker.ts";

const environmentId = EnvironmentId.make("environment:orbit");
const threadId = ThreadId.make("work-thread");
const own: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "session",
  issuedAt: 1,
  client: undefined,
  thread: {
    threadId,
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  capabilities: new Set(["orchestration"]),
};

it.effect(
  "binds fixed operations to verified scope, narrows children, and rereads the channel credential",
  () =>
    Effect.gen(function* () {
      let token = "broker-secret-one-aaaaaaaaaaaaaaaaaaaaaaaa";
      let active = true;
      const seen: Array<{ authorization: string | undefined; body: unknown; url: string }> = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          const body =
            request.body._tag === "Uint8Array"
              ? JSON.parse(new TextDecoder().decode(request.body.body))
              : undefined;
          seen.push({ authorization: request.headers.authorization, body, url: request.url });
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ thread: body.identity.threadId, ok: true }),
          );
        }),
      );
      const layer = OrbitBroker.layer.pipe(
        Layer.provide(Layer.mock(McpSessionRegistry.McpSessionRegistry)({})),
        Layer.provide(McpProviderSessions.layer),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        Layer.provide(
          Layer.succeed(
            FileSystem.FileSystem,
            FileSystem.makeNoop({
              readFileString: () => Effect.sync(() => token),
              stat: () => Effect.succeed({ mode: 0o600 } as FileSystem.File.Info),
            }),
          ),
        ),
        Layer.provide(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(environmentId),
          }),
        ),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.sync(() => ({
                ...liveThreadShell(id, active ? {} : { activeRunId: null }),
                lineage: {
                  rootThreadId: threadId,
                  parentThreadId: ThreadId.make("parent"),
                  relationshipToParent: "subagent" as const,
                },
              })),
          }),
        ),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_ORBIT_BROKER_TOKEN_FILE: "/private/broker-token",
                T3CODE_ORBIT_PORT: "4329",
              },
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const broker = yield* OrbitBroker.OrbitBroker;
        const call = (operation: typeof Operation.Type, args = {}, scope = own) =>
          broker
            .invoke({ operation, arguments: args })
            .pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, scope));
        expect(yield* call("orbit_context")).toEqual({ thread: threadId, ok: true });
        token = "broker-secret-two-bbbbbbbbbbbbbbbbbbbbbbbb";
        yield* call("ticket_update", { ticket: "ORBIT-20", note: "visible" });
        expect(seen.map((x) => x.authorization)).toEqual([
          "Bearer broker-secret-one-aaaaaaaaaaaaaaaaaaaaaaaa",
          `Bearer ${token}`,
        ]);
        expect(seen[1]?.body).toEqual({
          operation: "ticket_update",
          arguments: { ticket: "ORBIT-20", note: "visible", threadId },
          identity: { environmentId, threadId, providerSessionId: "session", subagent: false },
        });
        expect(seen.every((x) => x.url === "http://127.0.0.1:4329/internal/t3/tool")).toBe(true);
        for (const scope of [
          { ...own, environmentId: EnvironmentId.make("foreign") },
          {
            ...own,
            thread: undefined,
            client: { sessionId: "oauth", label: "external", access: "full-access" as const },
          },
          { ...own, thread: { ...own.thread!, subagent: true } },
        ]) {
          expect(
            (yield* call("ticket_update", { ticket: "ORBIT-20", note: "forged" }, scope).pipe(
              Effect.flip,
            )).code,
          ).toBe(scope.thread === undefined ? "thread_credential_required" : "capability_denied");
        }
        for (const args of [{ threadId: "orchestrator" }, { environmentId: "foreign" }])
          expect((yield* call("orbit_context", args).pipe(Effect.flip)).code).toBe(
            "capability_denied",
          );
        expect(seen).toHaveLength(2);
        expect(
          (yield* call(
            "orbit_context",
            {},
            { ...own, thread: { ...own.thread!, orbitNeedsAttestation: true } },
          ).pipe(Effect.flip)).code,
        ).toBe("capability_denied");
        const child = { ...own, thread: { ...own.thread!, subagent: true } };
        expect((yield* call("orbit_context", {}, child)).thread).toBe("parent");
        expect(seen[2]?.body).toMatchObject({ identity: { threadId: "parent", subagent: true } });
        active = false;
        expect((yield* call("ticket_update", { note: "after turn" }).pipe(Effect.flip)).code).toBe(
          "parent_not_active",
        );
        expect(seen).toHaveLength(3);
      }).pipe(Effect.provide(layer));
    }),
);

const brokerWith = (input: {
  readonly env: Record<string, string>;
  readonly mode?: number;
  readonly forwarded: Array<unknown>;
}) =>
  OrbitBroker.layer.pipe(
    Layer.provide(Layer.mock(McpSessionRegistry.McpSessionRegistry)({})),
    Layer.provide(McpProviderSessions.layer),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            input.forwarded.push(
              request.body._tag === "Uint8Array"
                ? JSON.parse(new TextDecoder().decode(request.body.body))
                : undefined,
            );
            return HttpClientResponse.fromWeb(request, Response.json({ ok: true }));
          }),
        ),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: () => Effect.succeed("broker-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
          stat: () => Effect.succeed({ mode: input.mode ?? 0o100600 } as FileSystem.File.Info),
        }),
      ),
    ),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
      }),
    ),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: input.env }))),
  );

const unavailableCode = (input: Omit<Parameters<typeof brokerWith>[0], "forwarded">) =>
  Effect.gen(function* () {
    const forwarded: Array<unknown> = [];
    const broker = yield* OrbitBroker.OrbitBroker.pipe(
      Effect.provide(brokerWith({ ...input, forwarded })),
    );
    const failure = yield* broker
      .invoke({ operation: "orbit_context" })
      .pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, own), Effect.flip);
    expect(forwarded).toEqual([]);
    return failure.code;
  });

const tokenFileEnv = { T3CODE_ORBIT_BROKER_TOKEN_FILE: "/private/broker-token" };

it.effect.each([
  ["off", {}],
  ["blank token file", { T3CODE_ORBIT_BROKER_TOKEN_FILE: "  " }],
  ...["80@example.com", "4319/../x", "0", "65536", "1e3", "-1", " 4319", "example.com"].map(
    (port) => [`port ${port}`, { ...tokenFileEnv, T3CODE_ORBIT_PORT: port }] as const,
  ),
] as const)("sends nothing and keeps the server up when %s", ([, env]) =>
  Effect.gen(function* () {
    expect(yield* unavailableCode({ env })).toBe("orchestration_error");
  }),
);

it.effect.each([0o100644, 0o100640, 0o100604])("refuses a token file with mode %o", (mode) =>
  Effect.gen(function* () {
    expect(yield* unavailableCode({ env: tokenFileEnv, mode })).toBe("orchestration_error");
  }),
);

it.effect.each([
  "http://example.com/internal/t3/tool",
  "http://127.0.0.1.example.com/internal/t3/tool",
  "http://127.0.0.1@example.com/internal/t3/tool",
  "http://user@127.0.0.1:4319/internal/t3/tool",
  "https://127.0.0.1:4319/internal/t3/tool",
  "http://localhost:4319/internal/t3/tool",
  "http://[::ffff:7f00:1]:4319/internal/t3/tool",
  "http://169.254.169.254/latest/meta-data",
])("the loopback guard fails %s before it reaches the transport", (url) =>
  Effect.gen(function* () {
    const sent: Array<string> = [];
    const client = OrbitBroker.loopbackOnly(
      HttpClient.make((request) =>
        Effect.sync(() => {
          sent.push(request.url);
          return HttpClientResponse.fromWeb(request, Response.json({}));
        }),
      ),
    );
    yield* client.get(url).pipe(Effect.flip);
    expect(sent).toEqual([]);
  }),
);

it("only ever builds a loopback URL", () => {
  expect(OrbitBroker.orbitBrokerUrl(undefined)).toBe("http://127.0.0.1:4319/internal/t3/tool");
  expect(OrbitBroker.orbitBrokerUrl("4329")).toBe("http://127.0.0.1:4329/internal/t3/tool");
  expect(OrbitBroker.orbitBrokerUrl("65536")).toBeUndefined();
});

it.effect("limits a provider with no native-child control to read-only context", () =>
  Effect.gen(function* () {
    const forwarded: Array<unknown> = [];
    const broker = yield* OrbitBroker.OrbitBroker.pipe(
      Effect.provide(brokerWith({ env: tokenFileEnv, forwarded })),
    );
    const scope = { ...own, thread: { ...own.thread!, orbitContextOnly: true } };
    const call = (operation: typeof Operation.Type) =>
      broker
        .invoke({ operation, arguments: { ticket: "ORBIT-20", note: "from a child?" } })
        .pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, scope));
    expect((yield* call("ticket_update").pipe(Effect.flip)).code).toBe("capability_denied");
    expect(forwarded).toEqual([]);
    yield* call("orbit_context");
    expect(forwarded).toMatchObject([{ identity: { threadId, subagent: true } }]);
  }),
);

it.each([
  [false, "codex", { orbitNeedsAttestation: false, orbitContextOnly: false }],
  [false, undefined, { orbitNeedsAttestation: false, orbitContextOnly: false }],
  [true, "codex", { orbitNeedsAttestation: true, orbitContextOnly: false }],
  [true, "claudeAgent", { orbitNeedsAttestation: false, orbitContextOnly: false }],
  [true, undefined, { orbitNeedsAttestation: true, orbitContextOnly: false }],
  ...["cursor", "grok", "kiro", "muse", "pi", "fx", "opencode", "acpRegistry", "antigravity"].map(
    (driver) => [true, driver, { orbitNeedsAttestation: false, orbitContextOnly: true }] as const,
  ),
] as const)("credential policy with broker %s for driver %s", (enabled, driver, policy) => {
  expect(orbitCredentialPolicy(enabled, driver)).toEqual(policy);
});
