import * as NodeServices from "@effect/platform-node/NodeServices";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import {
  extractAssistantImageInputs,
  persistAssistantImageInputs,
} from "./AssistantImageAttachments.ts";

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==";
const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-assistant-image-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

describe("extractAssistantImageInputs", () => {
  it("extracts MCP image blocks with raw base64 bytes", () => {
    expect(
      extractAssistantImageInputs({
        item: {
          type: "mcpToolCall",
          result: {
            content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
          },
        },
      }),
    ).toEqual([
      {
        _tag: "base64",
        base64: "aGVsbG8=",
        mimeType: "image/png",
        name: "generated-image.png",
      },
    ]);
  });

  it("extracts generated-image result objects containing data URLs", () => {
    expect(
      extractAssistantImageInputs({
        result: {
          content: [
            {
              type: "generated_image",
              image_url: "data:image/webp;base64,aGVsbG8=",
              output_hint: "concept.webp",
            },
          ],
        },
      }),
    ).toEqual([
      {
        _tag: "data-url",
        dataUrl: "data:image/webp;base64,aGVsbG8=",
        name: "concept.webp",
      },
    ]);
  });

  it("extracts Claude image blocks with nested base64 sources", () => {
    expect(
      extractAssistantImageInputs({
        type: "tool_result",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: ONE_PIXEL_PNG_BASE64,
            },
          },
        ],
      }),
    ).toEqual([
      {
        _tag: "base64",
        base64: ONE_PIXEL_PNG_BASE64,
        mimeType: "image/png",
        name: "generated-image.png",
      },
    ]);
  });

  it.effect("rejects oversized base64 before decoding", () =>
    Effect.gen(function* () {
      const oversizedBase64 = "A".repeat(Math.ceil(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / 3) * 4 + 4);
      expect(
        extractAssistantImageInputs({
          type: "image",
          mimeType: "image/png",
          data: oversizedBase64,
        }),
      ).toEqual([]);
      expect(
        yield* persistAssistantImageInputs({
          threadId: ThreadId.make("thread-oversized-image"),
          inputs: [
            {
              _tag: "base64",
              base64: oversizedBase64,
              mimeType: "image/png",
              name: "oversized.png",
            },
          ],
        }),
      ).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it("extracts only the explicit saved path from native image-generation items", () => {
    expect(
      extractAssistantImageInputs({
        item: {
          type: "imageGeneration",
          savedPath: "C:\\temp\\codex-generated.png",
          result: "completed",
        },
        path: "C:\\private\\not-an-image.txt",
      }),
    ).toEqual([
      {
        _tag: "local-file",
        path: "C:\\temp\\codex-generated.png",
        name: "codex-generated.png",
      },
    ]);
  });

  it("ignores arbitrary filesystem paths and unsafe image URLs", () => {
    expect(
      extractAssistantImageInputs({
        path: "C:\\Users\\me\\secret.png",
        image_url: "file:///C:/Users/me/secret.png",
        nested: { savedPath: "C:\\Users\\me\\also-secret.png" },
      }),
    ).toEqual([]);
  });

  it.effect("copies native generated files into the attachment store", () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const config = yield* ServerConfig.ServerConfig;
          const sourcePath = yield* fs.makeTempFileScoped({
            prefix: "codex-generated-",
            suffix: ".png",
          });
          const sourceBytes = Buffer.from(ONE_PIXEL_PNG_BASE64, "base64");
          yield* fs.writeFile(sourcePath, sourceBytes);

          const [attachment] = yield* persistAssistantImageInputs({
            threadId: ThreadId.make("thread-native-image"),
            inputs: [
              {
                _tag: "local-file",
                path: sourcePath,
                name: "codex-generated.png",
              },
            ],
          });
          if (!attachment) return null;
          const storedPath = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment,
          });
          if (!storedPath) return null;
          return {
            attachment,
            storedBytes: yield* fs.readFile(storedPath),
            sourcePath,
            storedPath,
          };
        }).pipe(Effect.provide(testLayer)),
      );

      expect(result?.attachment).toEqual(
        expect.objectContaining({
          type: "image",
          name: "codex-generated.png",
          mimeType: "image/png",
          sizeBytes: 67,
        }),
      );
      expect(result?.storedBytes).toEqual(Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));
      expect(result?.storedPath).not.toBe(result?.sourcePath);
      expect(result?.attachment).not.toHaveProperty("path");
    }),
  );
});
