import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertFullAccess, assertLiveCaller, readCaller, unavailable } from "../../threadAccess.ts";
import { AccessToolkit } from "./tools.ts";

// OAuth MCP grants deliberately do not include access administration, even at
// full access: issuing an HTTP credential would escape their MCP-only ceiling.
const access = Effect.gen(function* () {
  const context = yield* readCaller();
  const scope = yield* McpInvocationContext.requireThreadScope(
    context.scope,
    "Access administration",
  );
  yield* assertLiveCaller(context);
  yield* assertFullAccess(
    context,
    "Access administration needs a live full-access/default thread.",
  );
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== scope.environmentId) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  }
  return scope.thread.threadId;
});

const administer = <A>(
  operation: (
    auth: EnvironmentAuth.EnvironmentAuth["Service"],
  ) => Effect.Effect<A, EnvironmentAuth.ServerAuthInternalError>,
) =>
  Effect.gen(function* () {
    const threadId = yield* access;
    const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    return yield* executor.withLock(
      threadId,
      Effect.gen(function* () {
        // Recheck after waiting for a turn completion or mode change under the lock.
        yield* access;
        return yield* operation(yield* EnvironmentAuth.EnvironmentAuth).pipe(
          Effect.mapError(unavailable),
        );
      }),
    );
  });

export const layer = McpToolAccess.toLayer(AccessToolkit, {
  t3_pairing_create: McpToolAccess.writesEnvironment((input) =>
    administer((auth) => auth.issuePairingCredential(input)),
  ),
  t3_pairing_list: McpToolAccess.readsAsCaller(() =>
    administer((auth) =>
      auth.listPairingLinks().pipe(Effect.map((pairingLinks) => ({ pairingLinks }))),
    ),
  ),
  t3_pairing_revoke: McpToolAccess.writesEnvironment(({ id }) =>
    administer((auth) => auth.revokePairingLink(id).pipe(Effect.map((revoked) => ({ revoked })))),
  ),
  t3_client_list: McpToolAccess.readsAsCaller(() =>
    administer((auth) =>
      auth.listSessions().pipe(Effect.map((clientSessions) => ({ clientSessions }))),
    ),
  ),
  t3_client_revoke: McpToolAccess.writesEnvironment(({ sessionId }) =>
    administer((auth) =>
      auth.revokeSession(sessionId).pipe(Effect.map((revoked) => ({ revoked }))),
    ),
  ),
});
