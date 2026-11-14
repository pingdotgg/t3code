import { ATTACHMENT_UPLOAD_URL_TTL_MS, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PENDING_ATTACHMENT_MAX_AGE_MS } from "../attachmentStore.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

/** The sweep's clock starts at upload completion, possibly one upload-URL lifetime after issue. */
const OWNER_TTL_MS = PENDING_ATTACHMENT_MAX_AGE_MS + ATTACHMENT_UPLOAD_URL_TTL_MS;

const ownerKey = (scope: McpInvocationScope) => scope.thread?.threadId ?? scope.requestNamespace;

/** The MCP caller that prepared each pending upload. Kept in memory, so a restart orphans them. */
export class PendingUploadOwners extends Context.Service<
  PendingUploadOwners,
  {
    readonly record: (scope: McpInvocationScope, attachmentId: string) => Effect.Effect<void>;
    readonly requireOwner: (
      scope: McpInvocationScope,
      attachmentIds: ReadonlyArray<string>,
      action: "send" | "discard",
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly forget: (attachmentId: string) => Effect.Effect<void>;
  }
>()("t3/mcp/PendingUploadOwners") {}

export const layer = Layer.sync(PendingUploadOwners, () => {
  const owners = new Map<string, { readonly owner: string; readonly issuedAt: number }>();
  return PendingUploadOwners.of({
    record: Effect.fn("PendingUploadOwners.record")(function* (
      scope: McpInvocationScope,
      attachmentId: string,
    ) {
      const now = yield* Clock.currentTimeMillis;
      for (const [id, entry] of owners) {
        if (now - entry.issuedAt > OWNER_TTL_MS) owners.delete(id);
      }
      owners.set(attachmentId, { owner: ownerKey(scope), issuedAt: now });
    }),
    requireOwner: Effect.fn("PendingUploadOwners.requireOwner")(function* (
      scope: McpInvocationScope,
      attachmentIds: ReadonlyArray<string>,
      action: "send" | "discard",
    ) {
      const owner = ownerKey(scope);
      if (attachmentIds.every((id) => owners.get(id)?.owner === owner)) return;
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Only the caller that prepared a pending upload can ${action} it.`,
      });
    }),
    forget: Effect.fn("PendingUploadOwners.forget")((attachmentId: string) =>
      Effect.sync(() => {
        owners.delete(attachmentId);
      }),
    ),
  });
});
