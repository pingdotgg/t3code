import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthStandardClientScopes,
  AuthPairingCredentialResult,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";
import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as SessionStore from "../../../auth/SessionStore.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as Config from "../../../config.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";

const decodeCredential = Schema.decodeUnknownEffect(
  Schema.toCodecJson(AuthPairingCredentialResult),
);

const environmentId = EnvironmentId.make("environment:access");
const threadId = ThreadId.make("thread:access");
const caller: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "provider:access",
  thread: {
    threadId,
    providerSessionId: "provider:access",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};
const layerEnvironment = Layer.mock(Environment.ServerEnvironment)({
  getDescriptor: Effect.succeed({
    environmentId,
    label: "Test",
    serverVersion: "0.0.0",
    platform: { os: "linux", arch: "x64" },
    capabilities: { repositoryIdentity: false },
  }),
});
const layerAuth = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(Environment.layerIdentity),
  Layer.provide(Config.layerTest(process.cwd(), { prefix: "t3-mcp-access-" })),
);
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "access", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "access", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const call = (name: string, args: Record<string, unknown> = {}, scope = caller) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });
const failure = (result: McpSchema.CallToolResult) => {
  expect(result.isError).toBe(true);
  const block = result.content.find((block) => block.type === "text");
  if (block?.type !== "text") throw new Error("Missing failure payload");
  return JSON.parse(block.text);
};
const layerServer = McpHttpServer.layerAccessToolkit.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(layerEnvironment),
  Layer.provideMerge(layerAuth),
);
const layerThreads = Layer.mock(ThreadManagement.ThreadManagementService)({
  getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
});

it.layer(NodeServices.layer)("MCP access administration", (it) => {
  it.effect(
    "creates redeemable one-time credentials and revokes trusted client access through /mcp registration",
    () =>
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const created = yield* call("t3_pairing_create", { label: "Phone" });
        expect(created.isError, created.isError ? JSON.stringify(created) : undefined).toBe(false);
        const { credential, id } = yield* decodeCredential(created.structuredContent);

        const listed = yield* call("t3_pairing_list");
        expect(listed.structuredContent).toMatchObject({
          pairingLinks: [{ id, label: "Phone", permissions: AuthStandardClientScopes }],
        });
        expect(JSON.stringify(listed)).not.toContain(credential);
        const exchanged = yield* auth.exchangeBootstrapCredentialForAccessToken(
          credential,
          undefined,
          { label: "Phone", deviceType: "mobile" },
        );
        expect(
          yield* auth
            .exchangeBootstrapCredentialForAccessToken(credential, undefined, {
              deviceType: "mobile",
            })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "ServerAuthInvalidCredentialError" });
        const clients = yield* call("t3_client_list");
        expect(JSON.stringify(clients)).not.toContain(exchanged.access_token);
        expect(clients.structuredContent).toMatchObject({
          clientSessions: [{ client: { label: "Phone" }, current: false }],
        });
        const sessions = yield* auth.listSessions();
        const sessionId = sessions[0]?.sessionId;
        expect(sessionId).toBeDefined();
        expect((yield* call("t3_client_revoke", { sessionId })).structuredContent).toEqual({
          revoked: true,
        });
        expect((yield* call("t3_client_list")).structuredContent).toEqual({ clientSessions: [] });
        const store = yield* SessionStore.SessionStore;
        expect(yield* store.verify(exchanged.access_token).pipe(Effect.flip)).toMatchObject({
          _tag: "SessionTokenRevokedError",
        });
        const unused = yield* call("t3_pairing_create", { label: "Unused" });
        const { id: unusedId } = yield* decodeCredential(unused.structuredContent);
        expect((yield* call("t3_pairing_revoke", { id: unusedId })).structuredContent).toEqual({
          revoked: true,
        });
        expect((yield* call("t3_pairing_revoke", { id: unusedId })).structuredContent).toEqual({
          revoked: false,
        });
        expect((yield* call("t3_pairing_list")).structuredContent).toEqual({ pairingLinks: [] });
        const revokedCredential = yield* decodeCredential(unused.structuredContent);
        expect(
          yield* auth
            .exchangeBootstrapCredentialForAccessToken(revokedCredential.credential, undefined, {
              deviceType: "mobile",
            })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "ServerAuthInvalidCredentialError" });
      }).pipe(Effect.provide(layerServer.pipe(Layer.provide(layerThreads)))),
  );

  it.effect.each(["read-only", "approval-required", "full-access"] as const)(
    "refuses every access tool for an outside %s MCP client",
    (access) =>
      Effect.gen(function* () {
        const scope = {
          ...caller,
          thread: undefined,
          client: { sessionId: "outside", label: "Outside", access },
        };
        for (const [name, args] of [
          ["t3_pairing_create", { label: "Denied" }],
          ["t3_pairing_list", {}],
          ["t3_pairing_revoke", { id: "missing" }],
          ["t3_client_list", {}],
          ["t3_client_revoke", { sessionId: "missing" }],
        ] as const)
          expect(failure(yield* call(name, args, scope))).toHaveProperty("code");
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        expect(yield* auth.listPairingLinks()).toEqual([]);
        expect(yield* auth.listSessions()).toEqual([]);
      }).pipe(Effect.provide(layerServer.pipe(Layer.provide(layerThreads)))),
  );

  it.effect.each([
    {
      label: "restricted mode",
      shell: liveThreadShell(threadId, { runtimeMode: "approval-required" }),
      scope: caller,
      code: "capability_denied",
    },
    {
      label: "plan mode",
      shell: liveThreadShell(threadId, { interactionMode: "plan" }),
      scope: caller,
      code: "capability_denied",
    },
    {
      label: "ended turn",
      shell: liveThreadShell(threadId, { activeRunId: null }),
      scope: caller,
      code: "parent_not_active",
    },
    {
      label: "another environment",
      shell: liveThreadShell(threadId),
      scope: { ...caller, environmentId: EnvironmentId.make("other") },
      code: "capability_denied",
    },
  ])("refuses access administration for $label", ({ shell, scope, code }) =>
    Effect.gen(function* () {
      for (const name of ["t3_pairing_create", "t3_pairing_list", "t3_client_list"]) {
        expect(failure(yield* call(name, {}, scope))).toMatchObject({ code });
      }
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      expect(yield* auth.listPairingLinks()).toEqual([]);
    }).pipe(
      Effect.provide(
        layerServer.pipe(
          Layer.provide(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: () => Effect.succeed(shell),
            }),
          ),
        ),
      ),
    ),
  );

  it.effect.each(["turn", "runtime", "interaction"] as const)(
    "rechecks %s after waiting for its thread lock",
    (change) =>
      Effect.gen(function* () {
        const shell = yield* Ref.make<OrchestrationV2ThreadShell>(liveThreadShell(threadId));
        const checked = yield* Deferred.make<void>();
        const executorLayer = ThreadCommandExecutor.layer;
        yield* Effect.gen(function* () {
          const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
          const held = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const holder = yield* executor
            .withLock(
              threadId,
              Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(held);
          const pending = yield* call("t3_pairing_create").pipe(Effect.forkChild);
          yield* Deferred.await(checked);
          yield* Ref.update(shell, (value) =>
            change === "turn"
              ? { ...value, activeRunId: null }
              : change === "runtime"
                ? { ...value, runtimeMode: "approval-required" as const }
                : { ...value, interactionMode: "plan" as const },
          );
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(holder);
          expect(failure(yield* Fiber.join(pending))).toMatchObject({
            code: change === "turn" ? "parent_not_active" : "capability_denied",
          });
          const auth = yield* EnvironmentAuth.EnvironmentAuth;
          expect(yield* auth.listPairingLinks()).toEqual([]);
        }).pipe(
          Effect.provide(
            layerServer.pipe(
              Layer.provideMerge(executorLayer),
              Layer.provide(
                Layer.mock(ThreadManagement.ThreadManagementService)({
                  getThreadShell: () =>
                    Ref.get(shell).pipe(Effect.tap(() => Deferred.succeed(checked, undefined))),
                }),
              ),
            ),
          ),
        );
      }),
  );
});
