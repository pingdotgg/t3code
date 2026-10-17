import {
  AuthClientSession,
  AuthCreatePairingCredentialInput,
  AuthPairingCredentialResult,
  AuthPairingLink,
  AuthRevokeClientSessionInput,
  AuthRevokePairingLinkInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
    ThreadCommandExecutor.ThreadCommandExecutor,
    ServerEnvironment.ServerEnvironment,
    EnvironmentAuth.EnvironmentAuth,
  ],
};
const restriction =
  " Requires a live full-access/default thread in this environment; outside MCP clients cannot administer access.";

export const AccessToolkit = Toolkit.make(
  Tool.make("t3_pairing_create", {
    ...shared,
    description:
      "Create a one-time pairing credential for a new trusted client, with standard client permissions. The credential is returned only here; share privately using /pair#token=<credential> on a reachable server origin. Does not enable network access or save a connection on another device." +
      restriction,
    parameters: Schema.Struct({ label: AuthCreatePairingCredentialInput.fields.label }),
    success: Schema.toCodecJson(AuthPairingCredentialResult),
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_pairing_list", {
    ...shared,
    description:
      "List active pairing credentials as metadata, without their secrets." + restriction,
    success: Schema.Struct({ pairingLinks: Schema.Array(Schema.toCodecJson(AuthPairingLink)) }),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_pairing_revoke", {
    ...shared,
    description:
      "Revoke an unused pairing credential by id. Existing clients retain access; revoke their session separately." +
      restriction,
    parameters: AuthRevokePairingLinkInput,
    success: Schema.Struct({ revoked: Schema.Boolean }),
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_client_list", {
    ...shared,
    description:
      "List trusted client sessions and their permissions, without credentials. No session is marked current because the caller is a thread." +
      restriction,
    success: Schema.Struct({ clientSessions: Schema.Array(Schema.toCodecJson(AuthClientSession)) }),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_client_revoke", {
    ...shared,
    description:
      "Revoke a trusted client's sessionId from t3_client_list to remove its access." + restriction,
    parameters: AuthRevokeClientSessionInput,
    success: Schema.Struct({ revoked: Schema.Boolean }),
  }).annotate(Tool.Destructive, true),
);
