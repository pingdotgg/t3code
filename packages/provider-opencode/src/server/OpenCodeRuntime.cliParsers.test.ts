import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";

describe("parseServerUrlFromOutput", () => {
  it.each([
    ["opencode server listening on http://127.0.0.1:4096", null],
    ["opencode server listening on http://127.0.0.1:40961\n", "http://127.0.0.1:40961"],
    ["opencode server listening on http://127.0.0.1:40961\r\n", "http://127.0.0.1:40961"],
  ])("reads only a newline-terminated ready line: %j", (output, expected) => {
    NodeAssert.equal(OpenCodeRuntime.parseServerUrlFromOutput(output), expected);
  });
});

it.layer(NodeServices.layer)("toOpenCodeFileParts", (it) => {
  const attachment = (mimeType: string, sizeBytes = 12) => ({
    type: "file" as const,
    id: "thread-1-00000000-0000-4000-8000-000000000001-bin",
    name: "attachment",
    mimeType,
    sizeBytes,
  });

  it.effect("sends supported images, text, and PDFs natively and skips what models reject", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const parts = yield* OpenCodeRuntime.toOpenCodeFileParts({
        attachments: [
          attachment("application/pdf"),
          attachment("text/plain"),
          attachment("image/png"),
          // ZIP file parts fail Anthropic before turn start; send only the prompt's path line.
          attachment("application/zip"),
          // OpenCode inlines only text/plain; other text MIME parts fail Anthropic/OpenAI.
          attachment("text/html"),
          attachment("text/markdown"),
          attachment("application/octet-stream"),

          attachment("image/bmp"),
          attachment("image/svg+xml"),

          attachment("application/pdf", 21 * 1024 * 1024),
        ],
        resolveAttachmentPath: () => "/tmp/attachment",
        fileSystem,
      });

      NodeAssert.deepEqual(
        parts.map((part) => part.mime),
        ["application/pdf", "text/plain", "image/png"],
      );
    }),
  );

  it.effect("labels an image with the type its bytes have, not the declared one", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-opencode-attachment-" });
      const filePath = path.join(dir, "screenshot.jpg");
      yield* fileSystem.writeFile(
        filePath,
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      const parts = yield* OpenCodeRuntime.toOpenCodeFileParts({
        attachments: [{ ...attachment("image/jpeg"), type: "image" as const }],
        resolveAttachmentPath: () => filePath,
        fileSystem,
      });

      NodeAssert.deepEqual(
        parts.map((part) => part.mime),
        ["image/png"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("keeps folded clipboard text on the lazy path fallback", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const parts = yield* OpenCodeRuntime.toOpenCodeFileParts({
        attachments: [
          {
            ...attachment("text/plain"),
            source: { _tag: "pasted-text" as const },
          },
        ],
        resolveAttachmentPath: () => "/tmp/pasted-text.txt",
        fileSystem,
      });

      NodeAssert.deepEqual(parts, []);
    }),
  );
});
