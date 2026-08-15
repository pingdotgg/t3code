// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { parseThreadSegmentFromAttachmentId } from "../attachmentStore.ts";
import {
  deletePendingAttachment,
  issueAttachmentUploadUrl,
  storeAttachmentUpload,
  validateAttachmentUploadToken,
  ATTACHMENT_UPLOAD_ROUTE_PREFIX,
} from "./AttachmentUpload.ts";

const testLayer = ServerSecretStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-attachment-upload-" })),
  Layer.provideMerge(NodeServices.layer),
);

const uploadInput = {
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 6,
} as const;

describe("AttachmentUpload", () => {
  it.effect("mints a pending id and a token that validates round-trip", () =>
    Effect.gen(function* () {
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      expect(parseThreadSegmentFromAttachmentId(issued.attachmentId)).toBe("pending");
      expect(issued.relativeUrl.startsWith(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`)).toBe(true);

      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const claims = yield* validateAttachmentUploadToken(token);
      expect(claims).toMatchObject({
        kind: "attachment-upload",
        attachmentId: issued.attachmentId,
        mimeType: "image/png",
        sizeBytes: 6,
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a tampered token", () =>
    Effect.gen(function* () {
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const [payload, signature] = token.split(".");
      const tampered = `${payload}x.${signature}`;
      expect(yield* validateAttachmentUploadToken(tampered)).toBeNull();
      expect(yield* validateAttachmentUploadToken("garbage")).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("stores matching bytes and rejects a size mismatch", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const claims = yield* validateAttachmentUploadToken(token);
      if (!claims) throw new Error("expected valid claims");

      const short = yield* storeAttachmentUpload(claims, new Uint8Array([1, 2, 3]));
      expect(short).toMatchObject({ ok: false, status: 400 });

      const stored = yield* storeAttachmentUpload(claims, new Uint8Array(6));
      expect(stored).toEqual({ ok: true });
      const finalPath = NodePath.join(config.attachmentsDir, `${issued.attachmentId}.png`);
      expect(NodeFS.existsSync(finalPath)).toBe(true);
      // No .part residue after a successful store (suffix is per-request).
      const partResidue = NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.endsWith(".part"),
      );
      expect(partResidue).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("deletes pending uploads idempotently but never thread-scoped files", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
      const uuid = "00000000-0000-4000-8000-0000000000dd";
      const pendingPath = NodePath.join(config.attachmentsDir, `pending-${uuid}.png`);
      NodeFS.writeFileSync(pendingPath, Buffer.from("pixels"));

      yield* deletePendingAttachment(`pending-${uuid}`);
      expect(NodeFS.existsSync(pendingPath)).toBe(false);
      // Second delete is a no-op, not an error.
      yield* deletePendingAttachment(`pending-${uuid}`);

      const scopedUuid = "00000000-0000-4000-8000-0000000000ee";
      const scopedPath = NodePath.join(config.attachmentsDir, `thread-1-${scopedUuid}.png`);
      NodeFS.writeFileSync(scopedPath, Buffer.from("pixels"));
      // A delete aimed at a claimed attachment must not remove it.
      yield* deletePendingAttachment(`pending-${scopedUuid}`);
      yield* deletePendingAttachment(`thread-1-${scopedUuid}`);
      expect(NodeFS.existsSync(scopedPath)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );
});
