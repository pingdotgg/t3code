import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  applyAntigravityAcpModelSelection,
  antigravityPermissionDisposition,
  antigravityServesT3Code,
  antigravitySessionMeta,
  antigravitySessionMode,
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
  const setConfigOption = Effect.fn("AntigravityAcpSupportTest.setConfigOption")(function* (
    configId: string,
    value: string | boolean,
    options?: { readonly allowUnlistedValue?: boolean },
  ) {
    selections.push(
      `${configId}=${String(value)}${options?.allowUnlistedValue === true ? " (unlisted)" : ""}`,
    );
    return { configOptions };
  });
  return {
    runtime: { getConfigOptions: Effect.succeed(configOptions), setModel, setConfigOption },
    selections,
  };
}

describe("antigravityServesT3Code", () => {
  // The model manifest accepts the same `v` and `agy_acp_server_` prefixes.
  it.each([
    ["1.5.0", false],
    ["v1.5.0", false],
    ["agy_acp_server_1.5.0", false],
    ["1.5.1", true],
    ["agy_acp_server_1.5.12", true],
    ["custom", true],
  ] as const)("%s → %s", (version, serves) => {
    expect(antigravityServesT3Code(version)).toBe(serves);
  });
});

describe("Antigravity system prompt append", () => {
  it.each([false, true])("advertised append %s", (advertisedAppend) => {
    const initialize = {
      protocolVersion: 1,
      ...(advertisedAppend
        ? { agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } } }
        : {}),
    };
    // Helpers send no append.
    expect(antigravitySessionMeta(initialize)).toBeUndefined();
    expect(antigravitySessionMeta(initialize, "<pull_request_linking/>")).toEqual(
      advertisedAppend
        ? { antigravity: { systemPrompt: { append: "<pull_request_linking/>" } } }
        : undefined,
    );
  });
});

describe("Antigravity Auto", () => {
  it.each([
    { offered: ["default", "accept-edits", "auto", "plan"], expected: "auto" },
    { offered: ["default", "accept-edits", "plan"], expected: "default" },
  ])("runs as $expected when the session offers $offered", ({ offered, expected }) => {
    const modeState = {
      currentModeId: "default",
      availableModes: offered.map((id) => ({ id, name: id })),
    };
    expect(antigravitySessionMode("auto", modeState)).toBe(expected);
  });

  it.each(["execute", "read"] as const)("asks about the %s requests agy's Auto sends", (kind) => {
    const request = {
      sessionId: "session-1",
      toolCall: { toolCallId: "call-1", title: "Tool call", kind },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    } satisfies EffectAcpSchema.RequestPermissionRequest;
    expect(antigravityPermissionDisposition({ runtimeMode: "auto", cwd: null }, request)).toBe(
      "ask",
    );
  });

  it.each([{ type: "readOnly" }, { type: "workspaceWrite", writableRoots: [] }])(
    "keeps the $type sandbox's denials in Auto",
    (sandboxPolicy) => {
      const request = {
        sessionId: "session-1",
        toolCall: {
          toolCallId: "call-1",
          title: "Edit",
          kind: "edit",
          locations: [{ path: "/outside-workspace/file.txt" }],
        },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      } satisfies EffectAcpSchema.RequestPermissionRequest;
      expect(
        antigravityPermissionDisposition(
          { runtimeMode: "auto", cwd: "/workspace", sandboxPolicy },
          request,
        ),
      ).toBe("deny");
    },
  );

  it.each(["auto", "auto-accept-edits"] as const)(
    "runs only server-qualified T3 MCP calls unasked in %s",
    (runtimeMode) => {
      const policy = { runtimeMode, cwd: "/workspace" };
      const request = (
        title: string,
        rawInput?: Record<string, unknown>,
      ): EffectAcpSchema.RequestPermissionRequest => ({
        sessionId: "session-1",
        toolCall: { toolCallId: "call-1", title, kind: "execute", rawInput },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      });
      for (const t3Call of [
        request("Run mcp_t3-code_t3_thread_list?"),
        request("Run mcp_t3-code_tool_search?"),
        request("Run mcp_t3-code_tool_call?", { name: "preview_status", arguments: {} }),
        request("MCP Tool delegate_task", { ServerName: "t3-code", ToolName: "delegate_task" }),
        request("MCP Tool tool_call", {
          ServerName: "t3-code",
          ToolName: "tool_call",
          Arguments: { name: "preview_status", arguments: {} },
        }),
      ]) {
        expect(antigravityPermissionDisposition(policy, t3Call)).toBe("allow");
        expect(
          antigravityPermissionDisposition({ ...policy, approvalPolicy: "on-request" }, t3Call),
        ).toBe("ask");
        expect(
          antigravityPermissionDisposition(
            { ...policy, sandboxPolicy: { type: "readOnly" } },
            t3Call,
          ),
        ).toBe("deny");
      }
      for (const otherCall of [
        // Names no server, so another MCP server's tool of the same name looks identical.
        request("Running preview_status"),
        request("Running tool_call"),
        request("Run mcp_t3-code_tool_call?"),
        request("Run mcp_t3-code_tool_call?", { name: "tool_call", arguments: {} }),
        request("Run mcp_t3-code_tool_call?", { name: "tool_search", arguments: {} }),
        request("Run mcp_t3-code_tool_call?", { name: "unknown_tool", arguments: {} }),
        request("MCP Tool tool_call", {
          ServerName: "t3-code",
          ToolName: "tool_call",
          Arguments: { name: "unknown_tool", arguments: {} },
        }),
        request("Run mcp_github_create_issue"),
        request("MCP Tool preview_status", { ServerName: "other", ToolName: "preview_status" }),
        request("MCP Tool tool_call", { ServerName: "other", ToolName: "tool_call" }),
        request("Run mcp_t3-code_preview_status", {
          CommandLine: "Run mcp_t3-code_preview_status",
        }),
        // A directly called tool's rawInput is its own arguments, whatever their names.
        request("Run mcp_github_create_issue", {
          ServerName: "t3-code",
          ToolName: "delegate_task",
        }),
        request("Running create_issue", { ServerName: "t3-code", ToolName: "delegate_task" }),
        // call_mcp_tool is titled for the tool it calls.
        request("MCP Tool create_issue", { ServerName: "t3-code", ToolName: "delegate_task" }),
      ]) {
        expect(antigravityPermissionDisposition(policy, otherCall)).toBe("ask");
      }
    },
  );
});

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
          options: [{ groupId: "gemini", name: "Gemini", options: modelConfig.options }],
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

  it.effect("passes a model ID saved on runtime 1.3 to the agent as its 1.4 family", () =>
    Effect.gen(function* () {
      // The cold-resume model has no thinking option, so the level is unknown locally.
      const { runtime, selections } = makeModelRuntime([
        {
          ...modelConfig,
          currentValue: "gpt-oss-120b-medium",
          options: [
            { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
            { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
          ],
        },
      ]);
      const model = yield* applyAntigravityAcpModelSelection({
        runtime,
        model: "gemini-3.8-flash-low",
        mapError: (cause) => cause,
      });

      expect(model).toBe("gemini-3.8-flash");
      expect(selections).toEqual(["model=gemini-3.8-flash-low (unlisted)"]);
    }),
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
    const resolve = (attachment: ChatAttachment) =>
      resolveAttachmentPath({ attachmentsDir, attachment });
    return { fs, attachmentsDir, resolve, write };
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
        resolveAttachmentPath: fixture.resolve,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
      });

      expect(prompt).toEqual([
        { type: "text", text: "Explain this image." },
        { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
      ]);
    }),
  );

  it.effect.each(["utf8", "utf16le", "utf16be"] as const)(
    "embeds %s code from the selected environment and keeps the upload in place",
    (encoding) =>
      Effect.gen(function* () {
        const selectedEnvironment = yield* makeAttachmentFixture();
        const otherEnvironment = yield* makeAttachmentFixture();
        const source = '  const name = "caf\u00e9 🚀";\r\n';
        const bytes =
          encoding === "utf8" ? Buffer.from(source) : Buffer.from("\ufeff" + source, "utf16le");
        if (encoding === "utf16be") bytes.swap16();
        const upload = yield* selectedEnvironment.write(textAttachment, bytes);
        yield* otherEnvironment.write(textAttachment, "Different environment.");
        const prompt = yield* buildAntigravityPrompt({
          input: undefined,
          attachments: [textAttachment],
          resolveAttachmentPath: selectedEnvironment.resolve,
          promptCapabilities: { image: true, audio: true, embeddedContext: true },
        });

        expect(prompt).toEqual([
          {
            type: "resource",
            resource: { uri: upload.uri, mimeType: "application/octet-stream", text: source },
          },
        ]);
        expect(Buffer.from(yield* selectedEnvironment.fs.readFile(upload.filePath))).toEqual(bytes);
        expect(
          yield* selectedEnvironment.fs.readDirectory(selectedEnvironment.attachmentsDir),
        ).toHaveLength(1);
      }),
  );

  it.effect("keeps folded clipboard text out of native context", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const pastedText = {
        ...textAttachment,
        name: "pasted-text.txt",
        mimeType: "text/plain",
        source: { _tag: "pasted-text" as const },
      } satisfies ChatAttachment;
      yield* fixture.write(pastedText, "A very large crash report");

      const prompt = yield* buildAntigravityPrompt({
        input: "Inspect the pasted text only as needed.",
        attachments: [pastedText],
        resolveAttachmentPath: fixture.resolve,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
      });

      expect(prompt).toEqual([{ type: "text", text: "Inspect the pasted text only as needed." }]);
    }),
  );

  it.effect("keeps a Shift-JIS CSV as a file path instead of failing the prompt", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const csv = {
        ...textAttachment,
        name: "sample.csv",
        mimeType: "text/csv",
      } satisfies ChatAttachment;
      // "オーダー番号,ステータス\n1001,完了\n" encoded as CP932.
      const upload = yield* fixture.write(
        csv,
        Buffer.from("8349815b835f815b94d48d862c83588365815b835e83580a313030312c8aae97b90a", "hex"),
      );
      const input = `How many rows does this CSV have? ${upload.filePath}`;

      const prompt = yield* buildAntigravityPrompt({
        input,
        attachments: [csv],
        resolveAttachmentPath: fixture.resolve,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
      });

      expect(prompt).toEqual([{ type: "text", text: input }]);
    }),
  );

  it.effect.each([
    { name: "archive.zip", mimeType: "application/zip" },
    { name: "clip.mp4", mimeType: "video/mp4" },
    { name: "recording.aiff", mimeType: "audio/aiff" },
    { name: "large.pdf", mimeType: "application/pdf", sizeBytes: 75_000_000 },
    { name: "uploaded.json", mimeType: "application/json", sizeBytes: 85_104 },
    { name: "large.txt", mimeType: "text/plain", sizeBytes: 1024 * 1024 + 1 },
    { name: "large.wav", mimeType: "audio/wav", sizeBytes: 20 * 1024 * 1024 + 1 },
  ])("keeps $name as a file path without reading or spending the native media budget", (file) =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const attachment = { ...textAttachment, sizeBytes: 50 * 1024 * 1024, ...file };
      const upload = yield* fixture.write(attachment, "");
      yield* fixture.fs.truncate(upload.filePath, attachment.sizeBytes);
      const pdf = yield* fixture.write(pdfAttachment, "");
      yield* fixture.fs.truncate(pdf.filePath, 50 * 1024 * 1024);
      const input = `Inspect the file at ${upload.filePath}`;
      const prompt = yield* buildAntigravityPrompt({
        input,
        attachments: [attachment, pdfAttachment],
        resolveAttachmentPath: fixture.resolve,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fixture.fs,
          stream: () => {
            throw new Error("Path attachments must not be read into the prompt");
          },
        }),
      );
      expect(prompt).toEqual([
        { type: "text", text: input },
        {
          type: "resource_link",
          uri: pdf.uri,
          name: "report.pdf",
          mimeType: "application/pdf",
          size: 50 * 1024 * 1024,
        },
      ]);
    }),
  );

  it.effect.each([undefined, {}, { image: false, audio: false, embeddedContext: false }])(
    "keeps attachments path-only when native prompt capabilities are absent: %s",
    (promptCapabilities) =>
      Effect.gen(function* () {
        const fixture = yield* makeAttachmentFixture();
        const audio = {
          ...textAttachment,
          id: "unsupported-audio",
          name: "audio.wav",
          mimeType: "audio/wav",
        };
        const gifAttachment = {
          ...imageAttachment,
          id: "unsupported-gif",
          name: "animation.gif",
          mimeType: "image/gif",
        };
        const gif = yield* fixture.write(gifAttachment, "GIF89a");
        const image = yield* fixture.write(imageAttachment, "pixels");
        const pdf = yield* fixture.write(pdfAttachment, "%PDF-1.7");
        const text = yield* fixture.write(textAttachment, "hello");
        const sound = yield* fixture.write(audio, "RIFF");
        const input = `Read ${image.filePath}, ${gif.filePath}, ${pdf.filePath}, ${text.filePath}, and ${sound.filePath}`;
        const prompt = yield* buildAntigravityPrompt({
          input,
          attachments: [imageAttachment, gifAttachment, pdfAttachment, textAttachment, audio],
          resolveAttachmentPath: fixture.resolve,
          promptCapabilities,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fixture.fs,
            stream: () =>
              Effect.die("Unnegotiated attachments must not be read").pipe(Stream.fromEffect),
          }),
        );
        expect(prompt).toEqual([{ type: "text", text: input }]);
        expect(
          yield* buildAntigravityPrompt({
            input: "Continue",
            attachments: [],
            resolveAttachmentPath: fixture.resolve,
            promptCapabilities,
          }),
        ).toEqual([{ type: "text", text: "Continue" }]);
      }),
  );

  it.effect.each(["audio/wav", "audio/wav;codecs=1", "Audio/WAV \t; codecs=1"])(
    "sends supported audio files as native audio content (%s)",
    (mimeType) =>
      Effect.gen(function* () {
        const fixture = yield* makeAttachmentFixture();
        const audioAttachment = {
          ...textAttachment,
          id: "recording-1",
          name: "recording.wav",
          mimeType,
        } satisfies ChatAttachment;
        const bytes = Buffer.from("RIFF....WAVEfmt ", "latin1");
        yield* fixture.write(audioAttachment, bytes);
        const prompt = yield* buildAntigravityPrompt({
          input: "Transcribe this.",
          attachments: [audioAttachment],
          resolveAttachmentPath: fixture.resolve,
          promptCapabilities: { image: true, audio: true, embeddedContext: true },
        });

        expect(prompt).toEqual([
          { type: "text", text: "Transcribe this." },
          { type: "audio", data: bytes.toString("base64"), mimeType: "audio/wav" },
        ]);
      }),
  );

  it.effect.each([{ image: true }])(
    "keeps unsupported image formats path-only with capabilities %s",
    (promptCapabilities) =>
      Effect.gen(function* () {
        const fixture = yield* makeAttachmentFixture();
        const attachment = { ...imageAttachment, name: "animation.gif", mimeType: "image/gif" };
        const upload = yield* fixture.write(attachment, "GIF89a");
        const input = `Analyze the image at ${upload.filePath}`;
        const prompt = yield* buildAntigravityPrompt({
          input,
          attachments: [attachment],
          resolveAttachmentPath: fixture.resolve,
          promptCapabilities,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fixture.fs,
            stream: () => Effect.die("Unsupported images must not be read").pipe(Stream.fromEffect),
          }),
        );

        expect(prompt).toEqual([{ type: "text", text: input }]);
      }),
  );

  it.effect("rejects oversized images using file size instead of upload metadata", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const upload = yield* fixture.write(imageAttachment, "");
      yield* fixture.fs.truncate(upload.filePath, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1);
      const error = yield* buildAntigravityPrompt({
        input: "Read this attachment.",
        attachments: [imageAttachment],
        resolveAttachmentPath: fixture.resolve,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
      }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "AcpRequestError",
        code: -32602,
        errorMessage: expect.stringContaining("'screen.png' is too large"),
      });
    }),
  );

  it.effect("keeps PDF overflow on the file-path route", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const secondAttachment = {
        ...pdfAttachment,
        id: `${pdfAttachment.id}-second`,
        name: "second.pdf",
      };
      const first = yield* fixture.write(pdfAttachment, "");
      const second = yield* fixture.write(secondAttachment, "");
      yield* fixture.fs.truncate(first.filePath, (50 * 1024 * 1024) / 2);
      yield* fixture.fs.truncate(second.filePath, (50 * 1024 * 1024) / 2);
      const input = {
        input: `Read ${first.filePath} and ${second.filePath}`,
        attachments: [pdfAttachment, secondAttachment],
        resolveAttachmentPath: fixture.resolve,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
      };
      const prompt = yield* buildAntigravityPrompt(input);
      expect(prompt).toEqual([
        { type: "text", text: input.input },
        {
          type: "resource_link",
          uri: first.uri,
          name: "report.pdf",
          mimeType: "application/pdf",
          size: (50 * 1024 * 1024) / 2,
        },
        {
          type: "resource_link",
          uri: second.uri,
          name: "second.pdf",
          mimeType: "application/pdf",
          size: (50 * 1024 * 1024) / 2,
        },
      ]);

      yield* fixture.fs.truncate(second.filePath, (50 * 1024 * 1024) / 2 + 1);
      expect(yield* buildAntigravityPrompt(input)).toEqual([
        { type: "text", text: input.input },
        {
          type: "resource_link",
          uri: first.uri,
          name: "report.pdf",
          mimeType: "application/pdf",
          size: (50 * 1024 * 1024) / 2,
        },
      ]);
    }),
  );

  it.effect("still rejects images when the native budget is full", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const pdf = yield* fixture.write(pdfAttachment, "");
      yield* fixture.fs.truncate(pdf.filePath, 50 * 1024 * 1024);
      yield* fixture.write(imageAttachment, new Uint8Array([1]));
      const error = yield* buildAntigravityPrompt({
        input: "Inspect both attachments.",
        attachments: [pdfAttachment, imageAttachment],
        resolveAttachmentPath: fixture.resolve,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
      }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "AcpRequestError",
        errorMessage: expect.stringContaining("'screen.png' is too large"),
      });
    }),
  );

  it.effect("rejects aggregate overflow when a text upload grows after its size check", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const pdf = yield* fixture.write(pdfAttachment, "");
      const text = yield* fixture.write(textAttachment, "a");
      yield* fixture.fs.truncate(pdf.filePath, 50 * 1024 * 1024 - 1);
      const error = yield* buildAntigravityPrompt({
        input: undefined,
        attachments: [pdfAttachment, textAttachment],
        resolveAttachmentPath: fixture.resolve,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
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
    { bytes: new Uint8Array([0x80]), name: "invalid UTF-8" },
    { bytes: new Uint8Array([0xff, 0xfe, 0x61]), name: "invalid UTF-16LE" },
    { bytes: new Uint8Array([0xfe, 0xff, 0x00, 0x00]), name: "UTF-16BE NUL" },
    { bytes: new Uint8Array([0x61, 0, 0x62]), name: "NUL byte" },
  ])("keeps undecodable code as a file path: $name", ({ bytes }) =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      yield* fixture.write(textAttachment, bytes);
      const prompt = yield* buildAntigravityPrompt({
        input: "Read this file.",
        attachments: [textAttachment],
        resolveAttachmentPath: fixture.resolve,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
      });

      expect(prompt).toEqual([{ type: "text", text: "Read this file." }]);
    }),
  );

  it.effect("reports a missing upload instead of sending only the remaining text", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const error = yield* buildAntigravityPrompt({
        input: "Read this image.",
        attachments: [imageAttachment],
        resolveAttachmentPath: fixture.resolve,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "AcpRequestError",
        code: -32602,
        errorMessage: "Could not read attachment 'screen.png'.",
      });
    }),
  );
});
