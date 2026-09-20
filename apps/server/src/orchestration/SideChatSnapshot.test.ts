import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { ThreadId, OrchestrationThread } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../config.ts";
import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { snapshotSideChat } from "./SideChatSnapshot.ts";

const layer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-branch-attachments-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
it.layer(layer)("side chat attachments", (it) => {
  for (const streaming of [false, true]) {
    it.effect(`owns an independent file after the source is removed (streaming=${streaming})`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig;
        yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
        const attachment = {
          type: "file" as const,
          id: createAttachmentId("source", "txt")!,
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 6,
        };
        const originalPath = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment,
        })!;
        yield* fs.writeFileString(originalPath, "cobalt");
        const source = yield* Schema.decodeUnknownEffect(OrchestrationThread)({
          id: "source",
          projectId: "project",
          title: "Diet plan",
          modelSelection: { instanceId: "codex", model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          deletedAt: null,
          messages: [
            {
              id: "answer",
              role: "assistant",
              text: "cobalt",
              attachments: [attachment],
              context: {
                version: 1,
                records: [
                  {
                    version: 1,
                    contextId: "file-notes",
                    kind: "file",
                    label: "notes.txt",
                    attachmentId: attachment.id,
                    name: attachment.name,
                    mimeType: attachment.mimeType,
                    sizeBytes: attachment.sizeBytes,
                  },
                ],
              },
              turnId: null,
              streaming,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          activities: [],
          checkpoints: [],
          session: null,
        });
        const branch = yield* snapshotSideChat(source, ThreadId.make("independent"));
        const copy = branch.messages[0]!.attachments![0]!;
        expect(copy.id).not.toBe(attachment.id);
        expect(branch.messages[0]!.context?.records[0]).toMatchObject({ attachmentId: copy.id });
        expect(source.messages[0]!.context?.records[0]).toMatchObject({
          attachmentId: attachment.id,
        });
        yield* fs.remove(originalPath);
        expect(
          yield* fs.readFileString(
            resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment: copy })!,
          ),
        ).toBe("cobalt");
        expect(source.messages[0]!.attachments![0]!.id).toBe(attachment.id);
      }),
    );
  }
});
