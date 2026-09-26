import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { EnvironmentId, ProjectId, ThreadId } from "./baseSchemas.ts";

const Identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160));
export const ExtensionContentHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const ExtensionGrants = Schema.Struct({
  capabilities: Schema.Array(Identity).check(Schema.isMaxLength(16)),
  projectIds: Schema.Array(ProjectId).check(Schema.isMaxLength(64)),
});
/** Portable package metadata is validated against the public SDK at the host boundary. */
export const ExtensionInstallation = Schema.Struct({
  id: Identity,
  contentHash: ExtensionContentHash,
  package: Schema.JsonObject,
  enabled: Schema.Boolean,
  grants: ExtensionGrants,
});
export type ExtensionInstallation = typeof ExtensionInstallation.Type;
export const ExtensionViewContext = Schema.Struct({
  resource: Schema.Struct({
    namespace: Identity,
    id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
    environmentId: EnvironmentId,
    projectId: Schema.optional(ProjectId),
    threadId: Schema.optional(ThreadId),
  }),
  workspaceRevision: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
  client: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
export type ExtensionViewContext = typeof ExtensionViewContext.Type;
export const ExtensionInstallInput = Schema.Struct({
  sourceDir: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  ...ExtensionGrants.fields,
  trusted: Schema.Literal(true),
});
export type ExtensionInstallInput = typeof ExtensionInstallInput.Type;
export const ExtensionManageInput = Schema.Struct({
  id: Identity,
  action: Schema.Literals(["enable", "disable", "remove", "update", "rollback", "grants"]),
  grants: Schema.optional(ExtensionGrants),
  sourceDir: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
  trusted: Schema.optional(Schema.Literal(true)),
});
export type ExtensionManageInput = typeof ExtensionManageInput.Type;
export const ExtensionClientInput = Schema.Struct({
  id: Identity,
  expectedContentHash: ExtensionContentHash,
});
export type ExtensionClientInput = typeof ExtensionClientInput.Type;
export const ExtensionAssetInput = Schema.Struct({
  ...ExtensionClientInput.fields,
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
});
export type ExtensionAssetInput = typeof ExtensionAssetInput.Type;
export const ExtensionInvokeInput = Schema.Struct({
  toolId: Identity,
  input: Schema.Json,
  context: ExtensionViewContext,
  expectedContentHash: ExtensionContentHash,
});
export type ExtensionInvokeInput = typeof ExtensionInvokeInput.Type;
export class ExtensionOperationError extends Schema.TaggedError<ExtensionOperationError>()(
  "ExtensionOperationError",
  { operation: Schema.String, detail: Schema.String },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(ExtensionOperationError)(this, { status: 400 });
  }
  override get message(): string {
    return this.detail;
  }
}

/** V1 workspace identity shared by view opening, explicit context capture and server authorization. */
export function extensionWorkspaceRevision(
  projectWorkspaceRoot: string,
  threadWorktreePath: string | null,
): string {
  return JSON.stringify([projectWorkspaceRoot, threadWorktreePath]);
}

export const ExtensionApiInvocation = Schema.Struct({
  id: Identity,
  versionRange: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  method: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  input: Schema.Json,
  context: ExtensionViewContext,
  expectedGeneration: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  requestId: Schema.optional(Identity),
  /**
   * Session-validated routing hint for client-provider-backed contracts
   * (`t3.ui/*`). Stamped by the client's own ClientHost wrapper at invoke time;
   * the server accepts it only when the named connection is live and bound to
   * the same authenticated session the invoke arrived under. It can only ever
   * resolve to `self` — never a general target selector.
   */
  clientConnectionId: Schema.optional(Identity),
});
export const ExtensionApiInvokeInput = Schema.Struct({
  installationId: Identity,
  expectedContentHash: ExtensionContentHash,
  request: ExtensionApiInvocation,
});
export type ExtensionApiInvokeInput = typeof ExtensionApiInvokeInput.Type;
/** Streams are read-only and bound to an installed package and its current grants. */
export const ExtensionApiStreamInvocation = Schema.Struct({
  id: Identity,
  versionRange: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  input: Schema.Json,
  context: ExtensionViewContext,
  expectedGeneration: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
  /** Same session-validated `self` hint as `ExtensionApiInvocation`. */
  clientConnectionId: Schema.optional(Identity),
});
export const ExtensionApiSubscribeInput = Schema.Struct({
  installationId: Identity,
  expectedContentHash: ExtensionContentHash,
  request: ExtensionApiStreamInvocation,
});
export type ExtensionApiSubscribeInput = typeof ExtensionApiSubscribeInput.Type;
export const ExtensionApiStreamFrame = Schema.Struct({
  streamId: Identity,
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  type: Schema.Literals(["snapshot", "data", "reset", "closed"]),
  value: Schema.Json,
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
});
export type ExtensionApiStreamFrame = typeof ExtensionApiStreamFrame.Type;
export const ExtensionApiDiscoverInput = Schema.Struct({
  installationId: Identity,
  expectedContentHash: ExtensionContentHash,
  context: ExtensionViewContext,
});
export type ExtensionApiDiscoverInput = typeof ExtensionApiDiscoverInput.Type;
export const ExtensionApiSelection = Schema.Struct({
  id: Identity,
  providerId: Identity,
  fallbackProviderIds: Schema.Array(Identity).check(Schema.isMaxLength(32)),
});
export type ExtensionApiSelection = typeof ExtensionApiSelection.Type;
export const ExtensionApiDiscovery = Schema.Struct({
  id: Identity,
  version: Identity,
  providerId: Identity,
  pluginId: Schema.optional(Identity),
  generation: Schema.Int,
  health: Schema.Literals(["starting", "ready", "unavailable", "failed"]),
  selected: Schema.Boolean,
  reason: Schema.optional(
    Schema.Struct({
      code: Identity,
      detail: Schema.String,
      relatedIds: Schema.Array(Identity),
    }),
  ),
});

const ExtensionApiUnavailableReason = Schema.Struct({
  code: Identity,
  detail: Schema.String,
  relatedIds: Schema.Array(Identity),
});
export const ExtensionApiCatalogue = Schema.Struct({
  apiSelections: Schema.Array(ExtensionApiSelection),
  apiResolution: Schema.Array(
    Schema.Struct({
      id: Identity,
      providerId: Schema.optional(Identity),
      reason: Schema.optional(ExtensionApiUnavailableReason),
    }),
  ),
  pluginResolution: Schema.Array(
    Schema.Struct({
      id: Identity,
      status: Schema.Literals(["available", "disabled", "unavailable"]),
      reason: Schema.optional(ExtensionApiUnavailableReason),
    }),
  ),
});

/** A replayed metadata-only catalogue invalidation version. */
export const ExtensionCatalogueChange = Schema.Struct({
  epoch: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  revision: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
});
export type ExtensionCatalogueChange = typeof ExtensionCatalogueChange.Type;
