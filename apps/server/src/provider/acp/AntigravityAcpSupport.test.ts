import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  ANTIGRAVITY_MAX_TEXT_ATTACHMENT_BYTES,
  antigravityPermissionMode,
  applyAntigravityAcpModelSelection,
  buildAntigravityPrompt,
} from "./AntigravityAcpSupport.ts";

const modelConfig = {
  id: "model",
  name: "Model",
  type: "select",
  currentValue: "gemini-default",
  options: [
    { value: "gemini-default", name: "Gemini default" },
    { value: "gemini-saved", name: "Gemini saved" },
  ],
} satisfies EffectAcpSchema.SessionConfigOption;

function makeModelRuntime(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [modelConfig],
  failure?: EffectAcpErrors.AcpError,
) {
  const selections: string[] = [];
  const setModel = Effect.fn("AntigravityAcpSupportTest.setModel")(function* (model: string) {
    if (failure) return yield* failure;
    selections.push(model);
  });
  return {
    runtime: { getConfigOptions: Effect.succeed(configOptions), setModel },
    selections,
  };
}

describe("applyAntigravityAcpModelSelection", () => {
  it.effect("restores the saved model instead of the cold-resume default", () =>
    Effect.gen(function* () {
      const { runtime, selections } = makeModelRuntime();
      const model = yield* applyAntigravityAcpModelSelection({
        runtime,
        model: "gemini-saved",
        mapError: (cause) => cause,
      });

      expect(model).toBe("gemini-saved");
      expect(selections).toEqual(["gemini-saved"]);
    }),
  );

  it.effect("reapplies an explicit selection even when setup reports the same model", () =>
    Effect.gen(function* () {
      const { runtime, selections } = makeModelRuntime([
        { ...modelConfig, currentValue: "gemini-saved" },
      ]);
      const model = yield* applyAntigravityAcpModelSelection({
        runtime,
        model: "gemini-saved",
        mapError: (cause) => cause,
      });

      expect(model).toBe("gemini-saved");
      expect(selections).toEqual(["gemini-saved"]);
    }),
  );

  it.effect.each([undefined, null, ANTIGRAVITY_DEFAULT_MODEL])(
    "uses the native default for %s without sending an internal model ID",
    (requestedModel) =>
      Effect.gen(function* () {
        const { runtime, selections } = makeModelRuntime();
        const model = yield* applyAntigravityAcpModelSelection({
          runtime,
          model: requestedModel,
          mapError: (cause) => cause,
        });

        expect(model).toBe("gemini-default");
        expect(selections).toEqual([]);
      }),
  );

  it.effect("selects the manifest default for the alias when the account offers it", () =>
    Effect.gen(function* () {
      const { runtime, selections } = makeModelRuntime();
      const model = yield* applyAntigravityAcpModelSelection({
        runtime,
        model: ANTIGRAVITY_DEFAULT_MODEL,
        defaultModel: "gemini-saved",
        mapError: (cause) => cause,
      });
      expect(model).toBe("gemini-saved");
      expect(selections).toEqual(["gemini-saved"]);

      const { runtime: other, selections: otherSelections } = makeModelRuntime();
      const fallback = yield* applyAntigravityAcpModelSelection({
        runtime: other,
        model: ANTIGRAVITY_DEFAULT_MODEL,
        defaultModel: "gemini-not-offered",
        mapError: (cause) => cause,
      });
      expect(fallback).toBe("gemini-default");
      expect(otherSelections).toEqual([]);
    }),
  );

  it.effect.each(["gemini-removed", "Gemini saved", "gemini-saved[reasoning=high]"])(
    "rejects unavailable or non-native model ID %s without selecting a fallback",
    (model) =>
      Effect.gen(function* () {
        const { runtime, selections } = makeModelRuntime();
        const error = yield* applyAntigravityAcpModelSelection({
          runtime,
          model,
          mapError: (cause) => cause,
        }).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "AcpRequestError",
          code: -32602,
          errorMessage: expect.stringContaining(`'${model}' is unavailable`),
        });
        expect(selections).toEqual([]);
      }),
  );

  it.effect("accepts exact model IDs from grouped native options", () =>
    Effect.gen(function* () {
      const { runtime, selections } = makeModelRuntime([
        {
          ...modelConfig,
          options: [{ group: "gemini", name: "Gemini", options: modelConfig.options }],
        },
      ]);
      const model = yield* applyAntigravityAcpModelSelection({
        runtime,
        model: "gemini-saved",
        mapError: (cause) => cause,
      });

      expect(model).toBe("gemini-saved");
      expect(selections).toEqual(["gemini-saved"]);
    }),
  );

  it.effect("reports a native model-selection failure through the adapter error mapper", () =>
    Effect.gen(function* () {
      const nativeError = EffectAcpErrors.AcpRequestError.invalidParams("Model access changed.");
      const { runtime } = makeModelRuntime([modelConfig], nativeError);
      const error = yield* applyAntigravityAcpModelSelection({
        runtime,
        model: "gemini-saved",
        mapError: (cause) => ({ operation: "select-model", cause }),
      }).pipe(Effect.flip);

      expect(error).toEqual({ operation: "select-model", cause: nativeError });
    }),
  );
});

describe("antigravityPermissionMode", () => {
  it.each([
    { runtimeMode: "approval-required", nativeMode: "default" },
    { runtimeMode: "auto", nativeMode: "default" },
    { runtimeMode: "auto-accept-edits", nativeMode: "auto_edit" },
    { runtimeMode: "full-access", nativeMode: "yolo" },
  ] satisfies ReadonlyArray<{ runtimeMode: RuntimeMode; nativeMode: string }>)(
    "maps $runtimeMode to $nativeMode",
    ({ runtimeMode, nativeMode }) => {
      expect(antigravityPermissionMode(runtimeMode)).toBe(nativeMode);
    },
  );
});

const imageAttachment = {
  type: "image",
  id: "thread-00000000-0000-4000-8000-000000000001",
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 1,
} satisfies ChatAttachment;

const textAttachment = {
  type: "file",
  id: "thread-00000000-0000-4000-8000-000000000002-tsx",
  name: "example.tsx",
  mimeType: "application/octet-stream",
  sizeBytes: 1,
} satisfies ChatAttachment;

const pdfAttachment = {
  type: "file",
  id: "thread-00000000-0000-4000-8000-000000000003-pdf",
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1,
} satisfies ChatAttachment;

const makeAttachmentFixture = Effect.fn("AntigravityAcpSupportTest.makeAttachmentFixture")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const attachmentsDir = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-antigravity-attachments-",
    });
    const write = Effect.fn("AntigravityAcpSupportTest.writeAttachment")(function* (
      attachment: ChatAttachment,
      content: string | Uint8Array,
    ) {
      const filePath = resolveAttachmentPath({ attachmentsDir, attachment });
      if (filePath === null) throw new Error("Invalid test attachment path.");
      if (typeof content === "string") yield* fs.writeFileString(filePath, content);
      else yield* fs.writeFile(filePath, content);
      return { filePath, uri: (yield* path.toFileUrl(filePath)).href };
    });
    return { fs, attachmentsDir, write };
  },
);

it.layer(NodeServices.layer)("buildAntigravityPrompt", (it) => {
  it.effect("sends image bytes as native image content alongside the user prompt", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY9kAAAAASUVORK5CYII=",
        "base64",
      );
      yield* fixture.write(imageAttachment, bytes);
      const prompt = yield* buildAntigravityPrompt({
        input: "  Explain this image.  ",
        attachments: [imageAttachment],
        attachmentsDir: fixture.attachmentsDir,
      });

      expect(prompt).toEqual([
        { type: "text", text: "Explain this image." },
        { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
      ]);
    }),
  );

  it.effect("embeds UTF-8 code from the selected environment and keeps the upload in place", () =>
    Effect.gen(function* () {
      const selectedEnvironment = yield* makeAttachmentFixture();
      const otherEnvironment = yield* makeAttachmentFixture();
      const source = '  const name = "caf\u00e9";\n';
      const upload = yield* selectedEnvironment.write(textAttachment, source);
      yield* otherEnvironment.write(textAttachment, "Different environment.");
      const prompt = yield* buildAntigravityPrompt({
        input: undefined,
        attachments: [textAttachment],
        attachmentsDir: selectedEnvironment.attachmentsDir,
      });

      expect(prompt).toEqual([
        {
          type: "resource",
          resource: { uri: upload.uri, mimeType: "application/octet-stream", text: source },
        },
      ]);
      expect(yield* selectedEnvironment.fs.readFileString(upload.filePath)).toBe(source);
      expect(
        yield* selectedEnvironment.fs.readDirectory(selectedEnvironment.attachmentsDir),
      ).toHaveLength(1);
    }),
  );

  it.effect("sends supported audio files as native audio content", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const audioAttachment = {
        ...textAttachment,
        id: "recording-1",
        name: "recording.wav",
        mimeType: "audio/wav",
      } satisfies ChatAttachment;
      const bytes = Buffer.from("RIFF....WAVEfmt ", "latin1");
      yield* fixture.write(audioAttachment, bytes);
      const prompt = yield* buildAntigravityPrompt({
        input: "Transcribe this.",
        attachments: [audioAttachment],
        attachmentsDir: fixture.attachmentsDir,
      });

      expect(prompt).toEqual([
        { type: "text", text: "Transcribe this." },
        { type: "audio", data: bytes.toString("base64"), mimeType: "audio/wav" },
      ]);
    }),
  );

  it.effect("uses a PDF file resource link without copying or reading its bytes", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const upload = yield* fixture.write(pdfAttachment, "%PDF-1.7\n");
      const forbidFileAccess = () =>
        Effect.die("PDF prompt construction must only inspect the file.");
      const prompt = yield* buildAntigravityPrompt({
        input: undefined,
        attachments: [pdfAttachment],
        attachmentsDir: fixture.attachmentsDir,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fixture.fs,
          readFile: forbidFileAccess,
          writeFile: forbidFileAccess,
          writeFileString: forbidFileAccess,
          copyFile: forbidFileAccess,
          copy: forbidFileAccess,
          rename: forbidFileAccess,
        }),
      );

      expect(prompt).toEqual([
        { type: "resource_link", uri: upload.uri, name: "report.pdf", mimeType: "application/pdf" },
      ]);
    }),
  );

  it.effect.each([
    { ...imageAttachment, name: "animation.gif", mimeType: "image/gif" },
    { ...textAttachment, name: "archive.zip", mimeType: "application/zip" },
    { ...textAttachment, name: "recording.aiff", mimeType: "audio/aiff" },
  ] satisfies ReadonlyArray<ChatAttachment>)(
    "rejects $name instead of silently dropping it from a valid prompt",
    (attachment) =>
      Effect.gen(function* () {
        const fixture = yield* makeAttachmentFixture();
        yield* fixture.write(imageAttachment, new Uint8Array([1, 2, 3]));
        const error = yield* buildAntigravityPrompt({
          input: "Analyze every attachment.",
          attachments: [imageAttachment, attachment],
          attachmentsDir: fixture.attachmentsDir,
        }).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "AcpRequestError",
          code: -32602,
          errorMessage: expect.stringContaining(`does not support '${attachment.name}'`),
        });
      }),
  );

  it.effect.each([
    { attachment: textAttachment, bytes: ANTIGRAVITY_MAX_TEXT_ATTACHMENT_BYTES + 1 },
    { attachment: imageAttachment, bytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1 },
    { attachment: pdfAttachment, bytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1 },
  ])(
    "rejects oversized $attachment.name using file size instead of upload metadata",
    ({ attachment, bytes }) =>
      Effect.gen(function* () {
        const fixture = yield* makeAttachmentFixture();
        const upload = yield* fixture.write(attachment, "");
        yield* fixture.fs.truncate(upload.filePath, bytes);
        const error = yield* buildAntigravityPrompt({
          input: "Read this attachment.",
          attachments: [attachment],
          attachmentsDir: fixture.attachmentsDir,
        }).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "AcpRequestError",
          code: -32602,
          errorMessage: expect.stringContaining(`'${attachment.name}' is too large`),
        });
      }),
  );

  it.effect("accepts 50 MiB in total but rejects one byte more across files", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const secondAttachment = {
        ...pdfAttachment,
        id: `${pdfAttachment.id}-second`,
        name: "second.pdf",
      };
      const first = yield* fixture.write(pdfAttachment, "");
      const second = yield* fixture.write(secondAttachment, "");
      yield* fixture.fs.truncate(first.filePath, PROVIDER_SEND_TURN_MAX_FILE_BYTES / 2);
      yield* fixture.fs.truncate(second.filePath, PROVIDER_SEND_TURN_MAX_FILE_BYTES / 2);
      const input = {
        input: undefined,
        attachments: [pdfAttachment, secondAttachment],
        attachmentsDir: fixture.attachmentsDir,
      };
      const prompt = yield* buildAntigravityPrompt(input);
      expect(prompt).toEqual([
        { type: "resource_link", uri: first.uri, name: "report.pdf", mimeType: "application/pdf" },
        { type: "resource_link", uri: second.uri, name: "second.pdf", mimeType: "application/pdf" },
      ]);

      yield* fixture.fs.truncate(second.filePath, PROVIDER_SEND_TURN_MAX_FILE_BYTES / 2 + 1);
      const error = yield* buildAntigravityPrompt(input).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "AcpRequestError",
        code: -32602,
        errorMessage: expect.stringContaining("'second.pdf' is too large"),
      });
    }),
  );

  it.effect("rejects aggregate overflow when a text upload grows after its size check", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const pdf = yield* fixture.write(pdfAttachment, "");
      const text = yield* fixture.write(textAttachment, "a");
      yield* fixture.fs.truncate(pdf.filePath, PROVIDER_SEND_TURN_MAX_FILE_BYTES - 1);
      const error = yield* buildAntigravityPrompt({
        input: undefined,
        attachments: [pdfAttachment, textAttachment],
        attachmentsDir: fixture.attachmentsDir,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fixture.fs,
          stat: Effect.fn("AntigravityAcpSupportTest.growAfterStat")(function* (filePath: string) {
            const info = yield* fixture.fs.stat(filePath);
            if (filePath === text.filePath) {
              yield* fixture.fs.writeFileString(filePath, "ab");
            }
            return info;
          }),
        }),
        Effect.flip,
      );

      expect(error).toMatchObject({
        _tag: "AcpRequestError",
        code: -32602,
        errorMessage: "Attachment 'example.tsx' changed while being read and is too large.",
      });
    }),
  );

  it.effect.each([
    { bytes: new Uint8Array([0xff, 0xfe, 0x61]), message: "is not a UTF-8 text file" },
    { bytes: new Uint8Array([0x61, 0, 0x62]), message: "contains binary data" },
  ])("rejects binary data disguised as code: $message", ({ bytes, message }) =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      yield* fixture.write(textAttachment, bytes);
      const error = yield* buildAntigravityPrompt({
        input: undefined,
        attachments: [textAttachment],
        attachmentsDir: fixture.attachmentsDir,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "AcpRequestError",
        code: -32602,
        errorMessage: expect.stringContaining(message),
      });
    }),
  );

  it.effect("reports a missing upload instead of sending only the remaining text", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const error = yield* buildAntigravityPrompt({
        input: "Read this image.",
        attachments: [imageAttachment],
        attachmentsDir: fixture.attachmentsDir,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "AcpRequestError",
        code: -32602,
        errorMessage: "Could not read attachment 'screen.png'.",
      });
    }),
  );

  it.effect("rejects an empty turn", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const error = yield* buildAntigravityPrompt({
        input: "  ",
        attachments: [],
        attachmentsDir: fixture.attachmentsDir,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "AcpRequestError",
        code: -32602,
        errorMessage: "A turn requires text or supported attachments.",
      });
    }),
  );
});
