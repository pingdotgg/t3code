import {
  OrchestratorMcpFailure,
  type AuthClientSession,
  type AuthCreatePairingCredentialInput,
  type AuthPairingCredentialResult,
  type AuthPairingLink,
  type AuthSessionId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { assertFullAccess, assertLiveCaller, readCaller } from "./threadAccess.ts";

type AccessError = OrchestratorMcpFailure | EnvironmentAuth.ServerAuthInternalError;
type CallerScope = McpInvocationContext.McpInvocationScope;

export class AccessMcpService extends Context.Service<
  AccessMcpService,
  {
    readonly createPairingCredential: (
      scope: CallerScope,
      input: Pick<AuthCreatePairingCredentialInput, "label">,
    ) => Effect.Effect<AuthPairingCredentialResult, AccessError>;
    readonly listPairingLinks: (
      scope: CallerScope,
    ) => Effect.Effect<ReadonlyArray<AuthPairingLink>, AccessError>;
    readonly revokePairingLink: (
      scope: CallerScope,
      id: string,
    ) => Effect.Effect<boolean, AccessError>;
    readonly listClients: (
      scope: CallerScope,
    ) => Effect.Effect<ReadonlyArray<AuthClientSession>, AccessError>;
    readonly revokeClient: (
      scope: CallerScope,
      sessionId: AuthSessionId,
    ) => Effect.Effect<boolean, AccessError>;
  }
>()("t3/mcp/AccessMcpService") {}

const make = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const threads = yield* ThreadManagement.ThreadManagementService;

  // OAuth MCP grants deliberately exclude access administration: an HTTP
  // credential would escape their MCP-only ceiling, even with full access.
  const access = Effect.fn("AccessMcpService.authorize")(function* (scope: CallerScope) {
    const context = yield* readCaller().pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(ThreadManagement.ThreadManagementService, threads),
    );
    const caller = yield* McpInvocationContext.requireThreadScope(scope, "Access administration");
    yield* assertLiveCaller(context);
    yield* assertFullAccess(
      context,
      "Access administration needs a live full-access/default thread.",
    );
    const descriptor = yield* environment.getDescriptor;
    if (descriptor.environmentId !== scope.environmentId) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "This credential belongs to another environment.",
      });
    }
    return caller.thread.threadId;
  });

  const administer = Effect.fn("AccessMcpService.administer")(function* <A>(
    scope: CallerScope,
    operation: Effect.Effect<A, EnvironmentAuth.ServerAuthInternalError>,
  ) {
    const threadId = yield* access(scope);
    return yield* executor.withLock(
      threadId,
      Effect.gen(function* () {
        // Turn completion and mode changes may have committed while this waited.
        yield* access(scope);
        return yield* operation;
      }),
    );
  });

  return AccessMcpService.of({
    createPairingCredential: Effect.fn("AccessMcpService.createPairingCredential")((scope, input) =>
      administer(scope, auth.issuePairingCredential(input)),
    ),
    listPairingLinks: Effect.fn("AccessMcpService.listPairingLinks")((scope) =>
      administer(scope, auth.listPairingLinks()),
    ),
    revokePairingLink: Effect.fn("AccessMcpService.revokePairingLink")((scope, id) =>
      administer(scope, auth.revokePairingLink(id)),
    ),
    listClients: Effect.fn("AccessMcpService.listClients")((scope) =>
      administer(scope, auth.listSessions()),
    ),
    revokeClient: Effect.fn("AccessMcpService.revokeClient")((scope, sessionId) =>
      administer(scope, auth.revokeSession(sessionId)),
    ),
  });
});

export const layer = Layer.effect(AccessMcpService, make);
