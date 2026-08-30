import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AttachmentMcpDiscardUploadResult,
  AttachmentMcpPrepareUploadResult,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import {
  storeAttachmentUpload,
  validateAttachmentUploadToken,
} from "../../../assets/AttachmentUpload.ts";
import * as ServerConfig from "../../../config.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-attachment-mcp"),
  threadId: ThreadId.make("thread-attachment-mcp"),
  providerSessionId: "provider-session-attachment-mcp",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "attachment-mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const configLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-attachment-mcp-",
}).pipe(Layer.provide(NodeServices.layer));
const attachmentInfrastructure = ServerSecretStore.layer.pipe(
  Layer.provideMerge(configLayer),
  Layer.provideMerge(NodeServices.layer),
);
const testLayer = McpHttpServer.AttachmentToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(attachmentInfrastructure),
);

const decodePrepare = Schema.decodeUnknownEffect(AttachmentMcpPrepareUploadResult);
const decodeDiscard = Schema.decodeUnknownEffect(AttachmentMcpDiscardUploadResult);

describe("attachment MCP toolkit", () => {
  it.effect("prepares, uploads, and discards through the existing attachment store", () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const call = (name: string, args: Record<string, unknown>) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );

      const prepareCall = yield* call("t3_attachment_prepare_upload", {
        name: "screen.png",
        mimeType: "image/png",
        sizeBytes: 4,
      });
      expect(prepareCall.isError).toBe(false);
      const prepared = yield* decodePrepare(prepareCall.structuredContent).pipe(Effect.orDie);
      expect(prepared).toMatchObject({
        attachment: {
          id: prepared.attachmentId,
          type: "image",
          name: "screen.png",
          mimeType: "image/png",
          sizeBytes: 4,
        },
        type: "image",
        name: "screen.png",
        mimeType: "image/png",
        sizeBytes: 4,
        upload: { method: "POST" },
      });

      const token = prepared.upload.relativeUrl.split("/").at(-1)!;
      const claims = yield* validateAttachmentUploadToken(token);
      expect(claims).toMatchObject({ attachmentId: prepared.attachmentId });
      if (claims === null) return yield* Effect.die("Expected valid upload claims.");
      expect(yield* storeAttachmentUpload(claims, new Uint8Array([1, 2, 3, 4]))).toEqual({
        ok: true,
      });

      const discardCall = yield* call("t3_attachment_discard_upload", {
        attachmentId: prepared.attachmentId,
        uploadRelativeUrl: prepared.upload.relativeUrl,
      });
      expect(yield* decodeDiscard(discardCall.structuredContent).pipe(Effect.orDie)).toEqual({
        attachmentId: prepared.attachmentId,
        discarded: true,
      });
      // Repeating a pending-id discard is a truthful idempotent success.
      expect(
        yield* decodeDiscard(
          (yield* call("t3_attachment_discard_upload", {
            attachmentId: prepared.attachmentId,
            uploadRelativeUrl: prepared.upload.relativeUrl,
          })).structuredContent,
        ).pipe(Effect.orDie),
      ).toMatchObject({ discarded: true });

      const claimedDiscard = yield* call("t3_attachment_discard_upload", {
        attachmentId: "thread-attachment-mcp-00000000-0000-4000-8000-000000000001",
        uploadRelativeUrl: prepared.upload.relativeUrl,
      });
      expect(claimedDiscard.structuredContent).toMatchObject({
        _tag: "AttachmentMcpFailure",
        code: "invalid_attachment",
      });
    }).pipe(Effect.provide(testLayer)),
  );
});
