import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { WorkspaceMcpError } from "./errors.ts";

export type WorkspaceMcpPrincipal =
  | { readonly kind: "loopback" }
  | { readonly kind: "session"; readonly scopes: ReadonlySet<string> };

export class WorkspaceMcpAuth extends Context.Service<WorkspaceMcpAuth, WorkspaceMcpPrincipal>()(
  "t3/mcp/toolkits/workspace/principal/WorkspaceMcpAuth",
) {}

export const requireWorkspaceRead = Effect.fn("workspaceMcp.requireRead")(function* () {
  const principal = yield* WorkspaceMcpAuth;
  if (principal.kind === "session" && !principal.scopes.has(AuthOrchestrationReadScope)) {
    return yield* new WorkspaceMcpError({
      code: "forbidden",
      detail: "This credential cannot read T3 workspace state.",
    });
  }
  return principal;
});

export const requireWorkspaceOperate = Effect.fn("workspaceMcp.requireOperate")(function* () {
  const principal = yield* WorkspaceMcpAuth;
  if (principal.kind === "session" && !principal.scopes.has(AuthOrchestrationOperateScope)) {
    return yield* new WorkspaceMcpError({
      code: "forbidden",
      detail: "This credential cannot operate on T3 projects or threads.",
    });
  }
  return principal;
});
