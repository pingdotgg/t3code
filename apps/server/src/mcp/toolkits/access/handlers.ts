import * as Effect from "effect/Effect";
import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as AccessMcpService from "../../AccessMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { AccessToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(
  AccessToolkit,
  Effect.gen(function* () {
    const access = yield* AccessMcpService.AccessMcpService;
    return {
      t3_pairing_create: McpToolAccess.writesEnvironment((input) =>
        McpInvocationContext.McpInvocationContext.pipe(
          Effect.flatMap((scope) => access.createPairingCredential(scope, input)),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, unavailable),
        ),
      ),
      t3_pairing_list: McpToolAccess.readsAsCaller(() =>
        McpInvocationContext.McpInvocationContext.pipe(
          Effect.flatMap((scope) => access.listPairingLinks(scope)),
          Effect.map((pairingLinks) => ({ pairingLinks })),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, unavailable),
        ),
      ),
      t3_pairing_revoke: McpToolAccess.writesEnvironment(({ id }) =>
        McpInvocationContext.McpInvocationContext.pipe(
          Effect.flatMap((scope) => access.revokePairingLink(scope, id)),
          Effect.map((revoked) => ({ revoked })),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, unavailable),
        ),
      ),
      t3_client_list: McpToolAccess.readsAsCaller(() =>
        McpInvocationContext.McpInvocationContext.pipe(
          Effect.flatMap((scope) => access.listClients(scope)),
          Effect.map((clientSessions) => ({ clientSessions })),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, unavailable),
        ),
      ),
      t3_client_revoke: McpToolAccess.writesEnvironment(({ sessionId }) =>
        McpInvocationContext.McpInvocationContext.pipe(
          Effect.flatMap((scope) => access.revokeClient(scope, sessionId)),
          Effect.map((revoked) => ({ revoked })),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, unavailable),
        ),
      ),
    };
  }),
);
