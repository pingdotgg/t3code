import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema } from "effect/ai";
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/http";
import * as Sessions from "@t3tools/provider-core/server/McpProviderSessions";
import { EXTERNAL_TOOL_HOST_CHALLENGE_PREFIX } from "@t3tools/provider-core/server/mcpSession";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "./McpInvocationContext.ts";
import * as Registry from "./McpSessionRegistry.ts";
import { assertFullAccess, assertLiveCaller, readCaller } from "./threadAccess.ts";
import { assertNotLinked, callerLinkOrigin } from "./linkOrigin.ts";
import { readTargets } from "./ExternalToolTargets.ts";
import { makeSigner } from "./ExternalToolSigning.ts";
import { Input } from "./externalToolInput.ts";

const denied = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });
const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "External tool request failed.",
  });
const decodeResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

export class ExternalToolBroker extends Context.Service<
  ExternalToolBroker,
  {
    readonly verificationKey: { readonly keyId: string; readonly publicKeyPem: string };
    readonly invoke: (
      input: typeof Input.Type,
    ) => Effect.Effect<
      Record<string, unknown>,
      OrchestratorMcpFailure,
      Invocation.McpInvocationContext
    >;
  }
>()("t3/mcp/ExternalToolBroker") {}

const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const sessions = yield* Sessions.McpProviderSessions;
  const registry = yield* Registry.McpSessionRegistry;
  const threads = yield* Threads.ThreadManagementService;
  const environment = yield* Environment.ServerEnvironment;
  const targets = yield* readTargets;
  const signer = makeSigner();
  if (Object.keys(targets).length > 0)
    yield* Effect.logInfo("External tool verification key; pin out of band at each receiver.", {
      keyId: signer.keyId,
      publicKey: signer.publicKeyPem,
    });
  const checkedCaller = Effect.fn("ExternalToolBroker.checkedCaller")(function* () {
    const caller = yield* readCaller().pipe(
      Effect.provideService(Threads.ThreadManagementService, threads),
    );
    const scope = yield* Invocation.requireThreadScope(caller.scope, "external_tool");
    yield* assertLiveCaller(caller);
    yield* assertFullAccess(caller, "External tools require full-access/default mode.");
    yield* assertNotLinked(caller, "use host external tools.");
    if (scope.environmentId !== (yield* environment.getEnvironmentId))
      return yield* denied("Foreign environment.");
    if (
      caller.caller === undefined ||
      caller.caller.lineage.relationshipToParent === "subagent" ||
      scope.thread.subagent === true
    )
      return yield* denied("Children cannot invoke external tools.");
    if (!scope.thread.externalToolAttestationEnabled)
      return yield* denied("This provider cannot attest external tool calls.");
    const config = yield* sessions.read(scope.thread.threadId);
    if (
      config === undefined ||
      config.environmentId !== scope.environmentId ||
      config.threadId !== scope.thread.threadId ||
      config.providerInstanceId !== scope.thread.providerInstanceId ||
      config.providerSessionId !== scope.thread.providerSessionId ||
      !config.externalToolAttestationEnabled
    )
      return yield* denied("The provider session does not match.");
    return { caller, scope, config };
  });
  const invoke = Effect.fn("ExternalToolBroker.invoke")(function* (input: typeof Input.Type) {
    const { scope, config } = yield* checkedCaller();
    const target = Object.hasOwn(targets, input.target) ? targets[input.target] : undefined;
    if (target === undefined || !target.operations.includes(input.operation))
      return yield* denied("The target or operation is not configured.");
    const client = yield* Effect.serviceOption(McpSchema.McpServerClient);
    if (Option.isNone(client)) return yield* denied("Trusted provider callback unavailable.");
    const sessionId = scope.thread.providerSessionId;
    const challenge = yield* sessions.beginHostInvocation(sessionId);
    if (challenge === undefined) return yield* denied("Provider session unavailable.");
    const child = yield* Effect.scoped(
      Effect.gen(function* () {
        const reverse = yield* client.value.getClient;
        const reply = yield* reverse.elicit({
          mode: "form",
          message: EXTERNAL_TOOL_HOST_CHALLENGE_PREFIX + challenge,
          requestedSchema: {
            type: "object",
            properties: { confirmed: { type: "boolean" } },
            required: ["confirmed"],
          },
        });
        if (reply.action !== "accept") return yield* denied("Provider declined verification.");
        return yield* sessions.takeHostInvocation(challenge, sessionId);
      }),
    ).pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError(() => denied("Provider verification failed.")),
      Effect.ensuring(sessions.takeHostInvocation(challenge, sessionId)),
    );
    if (child !== false) return yield* denied("Unverified or child invocation.");
    // The round trip above can outlive a revocation, a stop or a session replacement.
    const current = yield* registry.resolve(config.authorizationHeader.replace(/^Bearer\s+/, ""));
    if (current?.thread.providerSessionId !== sessionId)
      return yield* denied("Provider credential expired or was revoked.");
    const { caller } = yield* checkedCaller();
    const signed = signer.sign(
      {
        target: input.target,
        operation: input.operation,
        arguments: input.arguments ?? {},
        identity: {
          environmentId: scope.environmentId,
          threadId: scope.thread.threadId,
          providerInstanceId: scope.thread.providerInstanceId,
          providerSessionId: sessionId,
          subagent: false,
          ...caller.limits,
          linkOrigin: callerLinkOrigin(caller) ?? null,
        },
      },
      yield* Clock.currentTimeMillis,
    );
    if (Buffer.byteLength(signed.body) > 65_536) return yield* unavailable();
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const response = yield* http.execute(
          HttpClientRequest.post(target.endpoint).pipe(
            HttpClientRequest.setHeaders({
              "x-t3-key-id": signer.keyId,
              "x-t3-signature": signed.signature,
            }),
            HttpClientRequest.setBody(HttpBody.text(signed.body, "application/json")),
          ),
        );
        if (response.status !== 200) return yield* unavailable();
        const bytes = yield* response.stream.pipe(
          Stream.runFoldEffect(
            () => ({ size: 0, chunks: [] as Uint8Array[] }),
            (state, chunk) => {
              const size = state.size + chunk.byteLength;
              return size > 65_536
                ? Effect.fail(unavailable())
                : Effect.succeed({ size, chunks: [...state.chunks, chunk] });
            },
          ),
        );
        return yield* decodeResult(Buffer.concat(bytes.chunks).toString("utf8"));
      }),
    ).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.timeout("15 seconds"),
      Effect.mapError(unavailable),
    );
  });
  return ExternalToolBroker.of({
    invoke,
    verificationKey: { keyId: signer.keyId, publicKeyPem: signer.publicKeyPem },
  });
});
export const layer = Layer.effect(ExternalToolBroker, make);
