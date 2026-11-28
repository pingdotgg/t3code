// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import type { ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/sql/SqlClient";

import { parseAttachmentIdFromFileName } from "../attachmentStore.ts";
import { threadOwnsAttachmentSql } from "../orchestration-v2/ProjectionStore.ts";

function normalizeForCompare(value: string): string {
  return HostProcess.Platform.defaultValue() === "win32" ? value.toLowerCase() : value;
}

export function makeThreadAttachmentAccess(input: {
  readonly sql: SqlClient.SqlClient;
  readonly fileSystem: FileSystem.FileSystem;
  readonly attachmentsDir: string;
}) {
  return Effect.fn("ProviderHost.canReadThreadAttachment")(
    function* (threadId: ThreadId, attachmentPath: string) {
      const root = yield* input.fileSystem.realPath(input.attachmentsDir).pipe(Effect.option);
      const candidate = yield* input.fileSystem.realPath(attachmentPath).pipe(Effect.option);
      if (Option.isNone(root) || Option.isNone(candidate)) return false;
      const canonicalPath = candidate.value;
      if (
        normalizeForCompare(NodePath.dirname(canonicalPath)) !== normalizeForCompare(root.value) ||
        NodePath.basename(canonicalPath) === ""
      ) {
        return false;
      }
      const attachmentId = parseAttachmentIdFromFileName(NodePath.basename(canonicalPath));
      return (
        attachmentId !== null && (yield* threadOwnsAttachmentSql(input.sql, threadId, attachmentId))
      );
    },
    Effect.catch((cause) =>
      Effect.logWarning("Thread attachment ownership lookup failed", cause).pipe(Effect.as(false)),
    ),
  );
}
