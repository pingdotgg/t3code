import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { ORBIT_HOST_CHALLENGE_PREFIX } from "@t3tools/provider-core/server/mcpSession";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import { NodeHttpClient } from "@effect/platform-node";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { HttpBody, HttpClient, HttpClientError, HttpClientRequest } from "effect/http";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { Input, orbitBrokerTokenFile } from "./orbitInput.ts";
import { assertLiveCaller, readCaller } from "./threadAccess.ts";

const refused = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });
const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "Orbit broker is unavailable. Check the T3 server's Orbit broker configuration.",
  });
const Result = Schema.Record(Schema.String, Schema.Unknown);
const decodeResult = Schema.decodeUnknownEffect(Result);

/** Undefined unless the value is a plain TCP port, so config cannot rewrite the URL's host. */
export const orbitBrokerUrl = (port: string | undefined) => {
  if (port === undefined) return "http://127.0.0.1:4319/internal/t3/tool";
  const parsed = /^\d{1,5}$/.test(port) ? Number(port) : 0;
  return parsed >= 1 && parsed <= 65535 ? `http://127.0.0.1:${parsed}/internal/t3/tool` : undefined;
};

const isLoopbackTarget = (target: string) => {
  const url = URL.parse(target);
  return (
    url?.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    url.username === "" &&
    url.password === ""
  );
};

/** [fork:lockdown] Prompts and tickets cross here; any other destination fails before sending. */
export const loopbackOnly = (client: HttpClient.HttpClient) =>
  HttpClient.mapRequestEffect(client, (request) =>
    isLoopbackTarget(request.url)
      ? Effect.succeed(request)
      : Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.InvalidUrlError({
              request,
              description: "Orbit broker traffic is restricted to loopback.",
            }),
          }),
        ),
  );

/**
 * [fork:lockdown] node:http with its own agent: unlike fetch it follows no redirect to another
 * host, and it ignores the NODE_USE_ENV_PROXY proxy that would otherwise see loopback traffic.
 */
export const layerLoopbackTransport = NodeHttpClient.layerNodeHttpOptions({ keepAlive: false });

export class OrbitBroker extends Context.Service<
  OrbitBroker,
  {
    readonly invoke: (
      input: typeof Input.Type,
    ) => Effect.Effect<
      typeof Result.Type,
      OrchestratorMcpFailure,
      McpInvocationContext.McpInvocationContext
    >;
  }
>()("t3/mcp/OrbitBroker") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const httpClient = loopbackOnly(yield* HttpClient.HttpClient);
  const sessions = yield* McpProviderSessions.McpProviderSessions;
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const tokenFile = yield* orbitBrokerTokenFile;
  const brokerUrl = orbitBrokerUrl(
    Option.getOrUndefined(yield* Config.option(Config.String("T3CODE_ORBIT_PORT"))),
  );
  const platform = yield* HostProcess.Platform;
  const invoke = Effect.fn("OrbitBroker.invoke")(function* (input: typeof Input.Type) {
    if (Option.isNone(tokenFile) || brokerUrl === undefined) return yield* unavailable();
    const caller = yield* readCaller().pipe(
      Effect.provideService(ThreadManagement.ThreadManagementService, threads),
    );
    const scope = yield* McpInvocationContext.requireThreadScope(caller.scope, "Orbit");
    yield* assertLiveCaller(caller);
    if (scope.environmentId !== (yield* environment.getEnvironmentId))
      return yield* refused("This session belongs to another environment.");
    const args = input.arguments ?? {};
    if (
      (args.threadId !== undefined && args.threadId !== scope.thread.threadId) ||
      (args.environmentId !== undefined && args.environmentId !== scope.environmentId)
    )
      return yield* refused("Tool identity does not match the authenticated T3 session.");
    let nativeChild = false;
    if (scope.thread.orbitNeedsAttestation === true) {
      const client = yield* Effect.serviceOption(McpSchema.McpServerClient);
      if (Option.isNone(client))
        return yield* refused("The trusted provider request context is unavailable.");
      const sessionId = scope.thread.providerSessionId;
      const config = yield* sessions.read(scope.thread.threadId);
      const challengeId = yield* sessions.beginHostInvocation(sessionId);
      if (config?.providerSessionId !== sessionId || challengeId === undefined)
        return yield* refused("The trusted provider invocation is unavailable.");
      const attested = yield* Effect.scoped(
        Effect.gen(function* () {
          const reverse = yield* client.value.getClient;
          const reply = yield* reverse.elicit({
            mode: "form",
            message: ORBIT_HOST_CHALLENGE_PREFIX + challengeId,
            requestedSchema: {
              type: "object",
              properties: { confirmed: { type: "boolean" } },
              required: ["confirmed"],
            },
          });
          if (reply.action !== "accept")
            return yield* refused("The provider declined host verification.");
        }),
      ).pipe(
        Effect.timeout("10 seconds"),
        Effect.mapError(() => refused("The provider could not verify this Orbit invocation.")),
        Effect.andThen(sessions.takeHostInvocation(challengeId, sessionId)),
        Effect.ensuring(sessions.takeHostInvocation(challengeId, sessionId)),
      );
      const current = yield* registry.resolve(config.authorizationHeader.replace(/^Bearer\s+/, ""));
      if (attested === undefined || current?.thread.providerSessionId !== sessionId)
        return yield* refused("The provider invocation is unverified, expired or revoked.");
      nativeChild = attested;
      yield* assertLiveCaller(
        yield* readCaller().pipe(
          Effect.provideService(ThreadManagement.ThreadManagementService, threads),
        ),
      );
    }
    // Providers without attestation or an SDK hook cannot tell a parent's call from a native child's.
    const contextOnly =
      scope.thread.subagent === true || nativeChild || scope.thread.orbitContextOnly;
    if (contextOnly === true && input.operation !== "orbit_context")
      return yield* refused("Subagents may only read their inherited Orbit context.");
    const tokenInfo = yield* fileSystem.stat(tokenFile.value).pipe(Effect.mapError(unavailable));
    if (platform !== "win32" && (tokenInfo.mode & 0o077) !== 0) {
      yield* Effect.logWarning(
        "Orbit broker token file is readable beyond its owner; refusing it.",
      );
      return yield* unavailable();
    }
    const token = yield* fileSystem
      .readFileString(tokenFile.value)
      .pipe(Effect.mapError(unavailable));
    if (token.trim().length < 32) return yield* unavailable();
    const threadId =
      scope.thread.subagent === true
        ? (caller.caller?.lineage.parentThreadId ?? scope.thread.threadId)
        : scope.thread.threadId;
    const body = yield* HttpBody.json({
      operation: input.operation,
      arguments: { ...args, threadId },
      identity: {
        environmentId: scope.environmentId,
        threadId,
        providerSessionId: scope.thread.providerSessionId,
        subagent: contextOnly === true,
      },
    }).pipe(Effect.mapError(unavailable));
    const response = yield* httpClient
      .execute(
        HttpClientRequest.post(brokerUrl).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${token.trim()}`),
          HttpClientRequest.setBody(body),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    const json = yield* response.json.pipe(Effect.mapError(unavailable));
    if (response.status !== 200) {
      // Only daemon rule errors are actionable; never relay transport errors or credentials.
      const error =
        typeof json === "object" && json !== null && "error" in json ? json.error : undefined;
      return yield* response.status >= 400 && response.status < 500 && typeof error === "string"
        ? refused(error.slice(0, 2000))
        : unavailable();
    }
    return yield* decodeResult(json).pipe(Effect.mapError(unavailable));
  });
  return OrbitBroker.of({ invoke });
});

export const layer = Layer.effect(OrbitBroker, make);
