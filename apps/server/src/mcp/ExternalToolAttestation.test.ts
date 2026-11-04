// @effect-diagnostics nodeBuiltinImport:off - real HTTP redirects and independent signature verification.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCryptoPlatform from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Sessions from "@t3tools/provider-core/server/McpProviderSessions";
import { EXTERNAL_TOOL_HOST_CHALLENGE_PREFIX } from "@t3tools/provider-core/server/mcpSession";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import { McpSchema } from "effect/ai";
import {
  HttpBody,
  HttpClient,
  HttpClientResponse,
  FetchHttpClient,
  HttpClientRequest,
} from "effect/http";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "./McpInvocationContext.ts";
import * as Registry from "./McpSessionRegistry.ts";
import * as Broker from "./ExternalToolBroker.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

it.effect(
  "requires host attestation and independently enforces caller, config, lifecycle and target gates",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const environmentId = EnvironmentId.make("test");
        const threadId = ThreadId.make("work");
        const env = Layer.mock(Environment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(environmentId),
        });
        let now = 1000;
        const registry = yield* Registry.__testing
          .make({ now: () => now, livenessWindowMs: 100 })
          .pipe(Effect.provide(env));
        const { config } = yield* registry.issue({
          threadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
          externalToolAttestationEnabled: true,
        });
        const scope = (yield* registry.resolve(config.authorizationHeader.slice(7)))!;
        const sessions = yield* Sessions.McpProviderSessions;
        yield* sessions.set(config);
        let receiverNow = 0;
        let pinnedKey: { keyId: string; publicKeyPem: string } | undefined;
        const consumed = new Set<string>();
        const received: Array<{ body: string; signature: string; keyId: string }> = [];
        let redirectFollowed = false;
        let redirectRequests = 0;
        const listener = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<NodeHttp.Server>((resolve) => {
                const server = NodeHttp.createServer(async (request, response) => {
                  if (request.url === "/receiver") {
                    let body = "";
                    for await (const chunk of request) body += chunk;
                    const signature = String(request.headers["x-t3-signature"] ?? "");
                    const keyId = String(request.headers["x-t3-key-id"] ?? "");
                    if (
                      !pinnedKey ||
                      keyId !== pinnedKey.keyId ||
                      !NodeCrypto.verify(
                        null,
                        Buffer.from(body),
                        pinnedKey.publicKeyPem,
                        Buffer.from(signature, "base64url"),
                      )
                    ) {
                      response.writeHead(401).end();
                      return;
                    }
                    const payload = JSON.parse(body);
                    if (
                      payload.version !== 1 ||
                      payload.target !== "receiver" ||
                      payload.operation !== "write" ||
                      payload.issuedAt > receiverNow ||
                      payload.expiresAt <= receiverNow ||
                      payload.expiresAt - payload.issuedAt > 30_000
                    ) {
                      response.writeHead(401).end();
                      return;
                    }
                    if (consumed.has(payload.requestId)) {
                      response.writeHead(409).end();
                      return;
                    }
                    consumed.add(payload.requestId);
                    received.push({ body, signature, keyId });
                    response
                      .writeHead(200, { "content-type": "application/json" })
                      .end('{"ok":true}');
                    return;
                  }
                  if (request.url === "/redirect") {
                    redirectRequests++;
                    response.writeHead(302, { location: "/sink" }).end();
                  } else if (request.url === "/sink") {
                    redirectFollowed = true;
                    response
                      .writeHead(200, { "content-type": "application/json" })
                      .end('{"ok":true}');
                  } else response.writeHead(404).end();
                });
                server.listen(0, "127.0.0.1", () => resolve(server));
              }),
          ),
          (server) =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  server.closeAllConnections();
                  server.close(() => resolve());
                }),
            ),
        );
        const address = listener.address();
        if (typeof address !== "object" || address === null)
          return yield* Effect.die("Expected a TCP fixture");
        const endpoint = `http://127.0.0.1:${address.port}/redirect`;
        const fetchClient = yield* HttpClient.HttpClient.pipe(
          Effect.provide(FetchHttpClient.layer),
        );
        const baseline = yield* fetchClient.execute(HttpClientRequest.post(endpoint));
        expect(baseline.status).toBe(200);
        expect(redirectFollowed).toBe(true);
        redirectFollowed = false;
        redirectRequests = 0;
        const observedStatuses: number[] = [];
        let useFetch = false;
        let shell = liveThreadShell(threadId);
        let response:
          | "echo"
          | "parent"
          | "child"
          | "foreign"
          | "revoke"
          | "expire"
          | "stop"
          | "replace"
          | "hang"
          | "decline" = "parent";
        let status = 200;
        let stall = false;
        const targetStarted = yield* Deferred.make<void>();
        let targetBody = '{"ok":true}';
        const forwarded: Array<{
          url: string;
          headers: Readonly<Record<string, string>>;
          body: string;
        }> = [];
        let elicitations = 0;
        let lastChallenge = "";
        const elicitationStarted = yield* Deferred.make<void>();
        const reverse: McpSchema.McpReverseClient = {
          listRoots: () => Effect.die("unused"),
          createMessage: () => Effect.die("unused"),
          elicit: (request) =>
            Effect.gen(function* () {
              elicitations++;
              lastChallenge = request.message.slice(EXTERNAL_TOOL_HOST_CHALLENGE_PREFIX.length);
              if (response === "hang")
                return yield* Deferred.succeed(elicitationStarted, undefined).pipe(
                  Effect.andThen(Effect.never),
                );
              if (response !== "echo")
                yield* sessions.attestHostInvocation(
                  request.message.slice(EXTERNAL_TOOL_HOST_CHALLENGE_PREFIX.length),
                  response === "foreign" ? "other" : config.providerSessionId,
                  response === "child",
                );
              if (response === "revoke")
                yield* registry.revokeProviderSession(config.providerSessionId);
              if (response === "expire") now += 101;
              if (response === "stop") shell = { ...shell, activeRunId: null };
              if (response === "replace")
                yield* sessions.set({ ...config, providerSessionId: "replacement" });
              return response === "decline"
                ? { action: "decline" as const }
                : { action: "accept" as const, content: { confirmed: true } };
            }),
        };
        const client = McpSchema.McpServerClient.of({
          clientId: 1,
          protocolVersion: "2025-06-18",
          clientCapabilities: { elicitation: {} },
          clientInfo: { name: "test", version: "1" },
          initializePayload: {
            protocolVersion: "2025-06-18",
            capabilities: { elicitation: {} },
            clientInfo: { name: "test", version: "1" },
          },
          getClient: Effect.succeed(reverse),
        });
        const layer = Broker.layer.pipe(
          Layer.provide(env),
          Layer.provide(Layer.succeed(Registry.McpSessionRegistry, registry)),
          Layer.provide(Layer.succeed(Sessions.McpProviderSessions, sessions)),
          Layer.provide(
            Layer.mock(Threads.ThreadManagementService)({
              getThreadShell: () => Effect.sync(() => shell),
            }),
          ),
          Layer.provide(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                useFetch
                  ? fetchClient
                      .execute(request)
                      .pipe(
                        Effect.tap((response) =>
                          Effect.sync(() => observedStatuses.push(response.status)),
                        ),
                      )
                  : stall
                    ? Deferred.succeed(targetStarted, undefined).pipe(Effect.andThen(Effect.never))
                    : Effect.sync(() => {
                        forwarded.push({
                          url: request.url,
                          headers: request.headers,
                          body:
                            request.body._tag === "Uint8Array"
                              ? new TextDecoder().decode(request.body.body)
                              : "",
                        });
                        return HttpClientResponse.fromWeb(
                          request,
                          new Response(targetBody, { status }),
                        );
                      }),
              ),
            ),
          ),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  T3CODE_EXTERNAL_TOOL_TARGETS: JSON.stringify({
                    sample: { endpoint, operations: ["read", "write"] },
                    receiver: {
                      endpoint: endpoint.replace("/redirect", "/receiver"),
                      operations: ["write"],
                    },
                  }),
                },
              }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const broker = yield* Broker.ExternalToolBroker;
          const input = { target: "sample", operation: "write" };
          const call = (changed = scope, args = input) =>
            broker
              .invoke(args)
              .pipe(
                Effect.provideService(Invocation.McpInvocationContext, changed),
                Effect.provideService(McpSchema.McpServerClient, client),
              );
          const reject = (changed = scope, args = input) =>
            Effect.gen(function* () {
              const before = forwarded.length;
              expect((yield* call(changed, args).pipe(Effect.flip)).code).toBeDefined();
              expect(forwarded).toHaveLength(before);
            });
          expect(yield* call()).toEqual({ ok: true });
          for (const mode of ["echo", "foreign", "child", "decline"] as const) {
            response = mode;
            yield* reject();
          }
          response = "parent";
          for (const changed of [
            { ...scope, environmentId: EnvironmentId.make("other") },
            {
              ...scope,
              thread: { ...scope.thread, providerInstanceId: ProviderInstanceId.make("other") },
            },
            { ...scope, thread: { ...scope.thread, providerSessionId: "other" } },
            { ...scope, thread: { ...scope.thread, subagent: true } },
            { ...scope, thread: { ...scope.thread, externalToolAttestationEnabled: false } },
          ]) {
            const before = elicitations;
            yield* reject(changed);
            expect(elicitations).toBe(before);
          }
          for (const changed of [
            { ...config, environmentId: EnvironmentId.make("other") },
            { ...config, threadId: ThreadId.make("other") },
            { ...config, providerInstanceId: ProviderInstanceId.make("other") },
            { ...config, providerSessionId: "other" },
            { ...config, externalToolAttestationEnabled: false },
          ]) {
            if (changed.threadId !== threadId) yield* sessions.clear(threadId);
            yield* sessions.set(changed);
            yield* reject();
            yield* sessions.set(config);
          }
          const original = shell;
          for (const changed of [
            {
              ...original,
              lineage: { ...original.lineage, relationshipToParent: "subagent" as const },
            },
            { ...original, runtimeMode: "approval-required" as const },
            { ...original, interactionMode: "plan" as const },
            {
              ...original,
              linkOrigin: { sessionId: "link", label: "test", access: "auto" as const },
            },
            { ...original, activeRunId: null },
          ]) {
            shell = changed;
            yield* reject();
          }
          shell = original;
          for (const args of [
            { target: "unknown", operation: "write" },
            { target: "sample", operation: "unknown" },
          ])
            yield* reject(scope, args);
          const result = yield* broker
            .invoke({ ...input, arguments: { threadId: "untrusted", environmentId: "data" } })
            .pipe(
              Effect.provideService(Invocation.McpInvocationContext, scope),
              Effect.provideService(McpSchema.McpServerClient, client),
            );
          expect(result).toEqual({ ok: true });
          const beforeOversize = forwarded.length;
          expect(
            (yield* broker
              .invoke({ ...input, arguments: { data: "x".repeat(65_536) } })
              .pipe(
                Effect.provideService(Invocation.McpInvocationContext, scope),
                Effect.provideService(McpSchema.McpServerClient, client),
                Effect.flip,
              )).code,
          ).toBe("orchestration_error");
          expect(forwarded).toHaveLength(beforeOversize);
          const sent = forwarded.at(-1)!;
          expect(sent.url).toBe(endpoint);
          expect(sent.headers.authorization).toBeUndefined();
          expect(sent.headers["x-t3-key-id"]).toBe(
            NodeCrypto.createHash("sha256")
              .update(broker.verificationKey.publicKeyPem)
              .digest("hex"),
          );
          expect(sent.headers["x-t3-key-id"]).toBe(broker.verificationKey.keyId);
          expect(
            NodeCrypto.verify(
              null,
              Buffer.from(sent.body),
              broker.verificationKey.publicKeyPem,
              Buffer.from(sent.headers["x-t3-signature"]!, "base64url"),
            ),
          ).toBe(true);
          expect(JSON.parse(sent.body)).toMatchObject({
            version: 1,
            target: "sample",
            operation: "write",
            arguments: { threadId: "untrusted", environmentId: "data" },
            identity: {
              threadId,
              environmentId,
              providerSessionId: config.providerSessionId,
              providerInstanceId: config.providerInstanceId,
              subagent: false,
              runtimeMode: "full-access",
              interactionMode: "default",
              linkOrigin: null,
            },
          });
          const origin = {
            sessionId: "trusted-link",
            label: "test",
            access: "full-access" as const,
          };
          shell = { ...original, linkOrigin: origin };
          expect(yield* call()).toEqual({ ok: true });
          expect(JSON.parse(forwarded.at(-1)!.body).identity.linkOrigin).toEqual(origin);
          shell = original;
          response = "hang";
          const elicitation = yield* call().pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(elicitationStarted);
          yield* TestClock.adjust("10 seconds");
          expect((yield* Fiber.join(elicitation)).code).toBe("capability_denied");
          expect(
            yield* sessions.attestHostInvocation(lastChallenge, config.providerSessionId, false),
          ).toBe(false);
          response = "parent";
          for (const code of [302, 401, 500]) {
            status = code;
            expect((yield* call().pipe(Effect.flip)).code).toBe("orchestration_error");
          }
          status = 200;
          for (const body of ["bad json", JSON.stringify({ data: "x".repeat(65_536) })]) {
            targetBody = body;
            expect((yield* call().pipe(Effect.flip)).code).toBe("orchestration_error");
          }
          targetBody = '{"ok":true}';
          useFetch = true;
          expect((yield* call().pipe(Effect.flip)).code).toBe("orchestration_error");
          expect(observedStatuses).toEqual([302]);
          expect(redirectRequests).toBe(1);
          expect(redirectFollowed).toBe(false);
          pinnedKey = broker.verificationKey;
          receiverNow = yield* Clock.currentTimeMillis;
          expect(yield* call(scope, { target: "receiver", operation: "write" })).toEqual({
            ok: true,
          });
          const accepted = received[0]!;
          const receiverPost = (
            body: string,
            signature = accepted.signature,
            keyId = accepted.keyId,
          ) =>
            fetchClient.execute(
              HttpClientRequest.post(endpoint.replace("/redirect", "/receiver")).pipe(
                HttpClientRequest.setHeaders({ "x-t3-signature": signature, "x-t3-key-id": keyId }),
                HttpClientRequest.setBody(HttpBody.text(body, "application/json")),
              ),
            );
          expect((yield* receiverPost(accepted.body)).status).toBe(409);
          expect((yield* receiverPost(accepted.body, "AAAA")).status).toBe(401);
          expect(
            (yield* receiverPost(accepted.body, accepted.signature, "unknown-key")).status,
          ).toBe(401);
          expect(
            (yield* receiverPost(
              sent.body,
              sent.headers["x-t3-signature"]!,
              sent.headers["x-t3-key-id"]!,
            )).status,
          ).toBe(401);
          receiverNow = JSON.parse(accepted.body).expiresAt;
          expect((yield* receiverPost(accepted.body)).status).toBe(401);
          useFetch = false;
          stall = true;
          const pending = yield* call().pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(targetStarted);
          yield* TestClock.adjust("15 seconds");
          expect((yield* Fiber.join(pending)).code).toBe("orchestration_error");
          stall = false;
          for (const mode of ["stop", "replace", "expire", "revoke"] as const) {
            response = mode;
            yield* reject();
            shell = original;
            now = 1000;
            yield* sessions.set(config);
          }
        }).pipe(Effect.provide(layer));
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          Sessions.layer,
          NodeHttpServer.layerTest,
          NodeServices.layer,
          NodeCryptoPlatform.layer,
        ),
      ),
    ),
);
