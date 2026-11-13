// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
// @effect-diagnostics anyUnknownInErrorContext:off
import * as DocumentText from "../../provider/DocumentText.ts";

import { text } from "../unknownField.ts";

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@t3tools/contracts";
import type { ChatAttachment } from "@t3tools/contracts";

import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";

import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";

import { planClaudeSkillDispatch } from "../../provider/Drivers/ClaudeSkillDispatch.ts";
import type { ClaudeSkillTarget } from "../../provider/Drivers/ClaudeSkillDispatch.ts";

import { providerMessageTextWithAttachmentPaths } from "@t3tools/provider-core/server/attachmentPrompt";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { CLAUDE_PROVIDER } from "./ClaudeProviderIdentity.ts";
import { encodeClaudeJson } from "./ClaudeQueryRunnerProtocol.ts";

export type ClaudeUserContent = SDKUserMessage["message"]["content"];
export type ClaudeUserContentBlock = Exclude<ClaudeUserContent, string>[number];

export const SUPPORTED_CLAUDE_IMAGE_MIME_TYPES = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
export type SupportedClaudeImageMimeType = (typeof SUPPORTED_CLAUDE_IMAGE_MIME_TYPES)[number];
export const supportedClaudeImageMimeTypes = new Set<string>(SUPPORTED_CLAUDE_IMAGE_MIME_TYPES);

export function isSupportedClaudeImageMimeType(
  mimeType: string,
): mimeType is SupportedClaudeImageMimeType {
  return supportedClaudeImageMimeTypes.has(mimeType);
}

export function makeClaudeUserMessage(input: {
  readonly text: string;
  readonly priority?: SDKUserMessage["priority"];
  readonly skills?: ReadonlyMap<string, ClaudeSkillTarget>;
  readonly uuid?: SDKUserMessage["uuid"];
}): SDKUserMessage {
  // Claude expands a skill only when `/name` starts the last text block.
  // Keep the whole request before that block; see ClaudeSkillDispatch.
  const dispatch =
    input.skills === undefined ? undefined : planClaudeSkillDispatch(input.text, input.skills);
  return {
    type: "user",
    message: {
      role: "user",
      content: dispatch
        ? [
            ...(dispatch.leadingText === undefined
              ? []
              : [{ type: "text" as const, text: dispatch.leadingText }]),
            { type: "text" as const, text: dispatch.commandText },
          ]
        : input.text,
    },
    parent_tool_use_id: null,
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.uuid === undefined ? {} : { uuid: input.uuid }),
  };
}

// Never decode streams just to enforce a provider limit. Only accept an explicit,
// uncompressed page tree whose /Count agrees with the visible page objects.
export const estimateClaudePdfPages = (bytes: Buffer): number | null => {
  if (bytes.length > 20 * 1024 * 1024 || bytes.subarray(0, 5).toString() !== "%PDF-") return null;
  if (!bytes.subarray(-1024).includes("%%EOF")) return null;
  let pages = 0;
  let count = 0;
  let catalog = false;
  let pageTree = false;
  let previous = "";
  const delimiter = (byte: number) =>
    byte <= 32 || "()<>[]{}/%".includes(String.fromCharCode(byte));
  for (let i = 0; i < bytes.length;) {
    const byte = bytes[i]!;
    if (byte === 37) {
      while (i < bytes.length && bytes[i] !== 10 && bytes[i] !== 13) i++;
      continue;
    }
    if (byte <= 32) {
      i++;
      continue;
    }
    if (previous === "/Type" && byte !== 47) return null;
    if (previous === "/Kids") {
      if (byte !== 91) return null;
      previous = "";
    }
    if (byte === 40) {
      let depth = 1;
      for (i++; i < bytes.length && depth > 0; i++) {
        if (bytes[i] === 92) i++;
        else if (bytes[i] === 40) depth++;
        else if (bytes[i] === 41) depth--;
      }
      if (depth !== 0) return null;
      previous = "";
      continue;
    }
    if (byte === 60 && bytes[i + 1] !== 60) {
      i = bytes.indexOf(62, i + 1);
      if (i < 0) return null;
      i++;
      previous = "";
      continue;
    }
    if (byte === 60 && bytes[i + 1] === 60) {
      i += 2;
      previous = "";
      continue;
    }
    if (delimiter(byte) && byte !== 47) {
      i++;
      continue;
    }
    const start = i++;
    while (i < bytes.length && !delimiter(bytes[i]!)) i++;
    if (i - start > 64) return null;
    const token = bytes.toString("latin1", start, i);
    if (token.includes("#") || ["/ObjStm", "/XRef", "/Encrypt", "/Prev"].includes(token))
      return null;
    if (token === "stream") {
      i = bytes.indexOf("endstream", i);
      if (i < 0) return null;
      i += 9;
      previous = "";
      continue;
    }
    if (previous === "/Type") {
      if (token === "/Page") pages++;
      if (token === "/Catalog") catalog = true;
      if (token === "/Pages") pageTree = true;
    }
    if (previous === "/Count") {
      if (!/^[1-9]\d{0,8}$/.test(token)) return null;
      let next = i;
      while (next < bytes.length) {
        if (bytes[next]! <= 32) next++;
        else if (bytes[next] === 37) {
          while (next < bytes.length && bytes[next] !== 10 && bytes[next] !== 13) next++;
        } else break;
      }
      // A second scalar is an indirect reference, not a direct page count.
      if (next < bytes.length && !delimiter(bytes[next]!)) return null;
      count = Math.max(count, Number(token));
    }
    previous = token;
  }
  return catalog && pageTree && pages > 0 && count === pages ? pages : null;
};

export const CLAUDE_ATTACHMENT_MAX_BYTES = 28 * 1024 * 1024;
export const CLAUDE_ATTACHMENT_MAX_PAGES = 100;

export const makeClaudeAttachmentBudget = (used?: { pagesUsed: number; bytesUsed: number }) => ({
  committed: { pages: used?.pagesUsed ?? 0, bytes: used?.bytesUsed ?? 0 },
  pending: { pages: 0, bytes: 0 },
  compacting: null as { pages: number; bytes: number } | null,
  get remainingPages() {
    return CLAUDE_ATTACHMENT_MAX_PAGES - this.committed.pages - this.pending.pages;
  },
  get remainingBytes() {
    return CLAUDE_ATTACHMENT_MAX_BYTES - this.committed.bytes - this.pending.bytes;
  },
});

export const reserveClaudePdfBudget = (
  budget: ReturnType<typeof makeClaudeAttachmentBudget>,
  persist: Effect.Effect<void>,
) =>
  Effect.acquireRelease(
    Effect.sync(() => ({
      budget,
      pages: 0,
      bytes: 0,
      delivered: false,
      commit() {
        if (this.delivered) return;
        this.delivered = true;
        budget.pending.pages -= this.pages;
        budget.pending.bytes -= this.bytes;
        budget.committed.pages += this.pages;
        budget.committed.bytes += this.bytes;
      },
    })),
    (reservation) =>
      Effect.sync(() => {
        if (reservation.delivered) return;
        budget.pending.pages -= reservation.pages;
        budget.pending.bytes -= reservation.bytes;
      }).pipe(Effect.andThen(persist)),
  );

export const makeClaudeUserMessageWithAttachments = Effect.fnUntraced(function* (input: {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly priority?: SDKUserMessage["priority"];
  readonly uuid?: SDKUserMessage["uuid"];
  readonly attachmentsDir: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly pdfReservation: Effect.Success<ReturnType<typeof reserveClaudePdfBudget>>;
  readonly skills?: ReadonlyMap<string, ClaudeSkillTarget>;
}) {
  if (input.attachments.length === 0) {
    const message = makeClaudeUserMessage({
      text: input.text,
      ...(input.skills === undefined ? {} : { skills: input.skills }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.uuid === undefined ? {} : { uuid: input.uuid }),
    });
    const bytes = Buffer.byteLength(encodeClaudeJson(message.message.content));
    input.pdfReservation.budget.pending.bytes += bytes;
    input.pdfReservation.bytes += bytes;
    return message;
  }

  const textWithAttachmentPaths = yield* providerMessageTextWithAttachmentPaths({
    text: input.text,
    attachments: input.attachments,
    resolveExtractedTextPath: (path) =>
      DocumentText.resolveExtractedTextPath(path).pipe(
        Effect.provideService(FileSystem.FileSystem, input.fileSystem),
      ),
    resolveAttachmentPath: (attachment) =>
      resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment }),
  });

  const dispatch =
    input.skills === undefined
      ? undefined
      : planClaudeSkillDispatch(textWithAttachmentPaths, input.skills);
  const content: Array<ClaudeUserContentBlock> = [];
  // Base64 adds a third to the payload. Leave room below Anthropic's 32 MB
  // request limit for text, instructions, and SDK framing. The SDK does not
  // expose document/context-window capabilities, so use the 100-page limit
  // that also applies to models with less than a 1M-token context window.
  if (dispatch?.leadingText !== undefined) {
    content.push({ type: "text", text: dispatch.leadingText });
  }

  // Reserve all text and actual image bytes before considering any document,
  // including images that follow it in attachment order.
  const images = new Map<number, ClaudeUserContentBlock>();
  const textBytes = Buffer.byteLength(
    encodeClaudeJson(
      dispatch
        ? [
            ...(dispatch.leadingText === undefined
              ? []
              : [{ type: "text", text: dispatch.leadingText }]),
            { type: "text", text: dispatch.commandText },
          ]
        : [{ type: "text", text: textWithAttachmentPaths }],
    ),
  );
  input.pdfReservation.budget.pending.bytes += textBytes;
  input.pdfReservation.bytes += textBytes;
  for (const [index, attachment] of input.attachments.entries()) {
    if (attachment.type !== "image") continue;
    if (!isSupportedClaudeImageMimeType(attachment.mimeType)) {
      return yield* new ProviderAdapter.ProviderAdapterProtocolError({
        driver: CLAUDE_PROVIDER,
        detail: `Unsupported Claude image attachment type '${attachment.mimeType}'`,
      });
    }
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment,
    });
    if (attachmentPath === null) {
      return yield* new ProviderAdapter.ProviderAdapterProtocolError({
        driver: CLAUDE_PROVIDER,
        detail: `Invalid attachment id '${attachment.id}'`,
      });
    }
    const bytes = yield* input.fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapter.ProviderAdapterProtocolError({
            driver: CLAUDE_PROVIDER,
            detail: `Failed to read attachment '${attachment.id}'`,
            reason: "attachment_unreadable",
            payload: cause,
          }),
      ),
    );
    const retainedBytes = 4 * Math.ceil(bytes.length / 3) + 128;
    if (retainedBytes > input.pdfReservation.budget.remainingBytes) continue;
    input.pdfReservation.budget.pending.bytes += retainedBytes;
    input.pdfReservation.bytes += retainedBytes;
    const block: ClaudeUserContentBlock = {
      type: "image",
      source: {
        type: "base64",
        media_type: attachment.mimeType,
        data: Buffer.from(bytes).toString("base64"),
      },
    };
    images.set(index, block);
  }
  for (const [index, attachment] of input.attachments.entries()) {
    if (attachment.type === "file") {
      if (
        input.pdfReservation.budget.remainingPages <= 0 ||
        attachment.mimeType.toLowerCase().split(";", 1)[0]?.trim() !== "application/pdf" ||
        ("source" in attachment && attachment.source?._tag === "pasted-text")
      )
        continue;
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: input.attachmentsDir,
        attachment,
      });
      if (attachmentPath === null) continue;
      const remainingBytes = Math.min(
        PROVIDER_SEND_TURN_MAX_FILE_BYTES,
        20 * 1024 * 1024,
        Math.floor(((input.pdfReservation.budget.remainingBytes - 1024) * 3) / 4),
      );
      const info = yield* input.fileSystem
        .stat(attachmentPath)
        .pipe(Effect.orElseSucceed(() => null));
      if (info?.type !== "File" || Number(info.size) > remainingBytes || remainingBytes <= 0)
        continue;
      const bytes = yield* input.fileSystem
        .stream(attachmentPath, { bytesToRead: remainingBytes + 1 })
        .pipe(
          Stream.runCollect,
          Effect.map((chunks) => Buffer.concat(chunks)),
          Effect.orElseSucceed(() => null),
        );
      if (bytes === null || bytes.length > remainingBytes) continue;
      const pageCount = estimateClaudePdfPages(bytes);
      if (pageCount === null) {
        yield* Effect.logDebug("Claude PDF page count is unknown; keeping attachment path-only.");
        continue;
      }
      const retainedBytes = 4 * Math.ceil(bytes.length / 3) + 128;
      if (
        pageCount <= 0 ||
        pageCount > input.pdfReservation.budget.remainingPages ||
        retainedBytes > input.pdfReservation.budget.remainingBytes
      )
        continue;
      input.pdfReservation.budget.pending.pages += pageCount;
      input.pdfReservation.pages += pageCount;
      const block: ClaudeUserContentBlock = {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") },
      };
      input.pdfReservation.budget.pending.bytes += retainedBytes;
      input.pdfReservation.bytes += retainedBytes;
      content.push(block);
      continue;
    }
    const image = images.get(index);
    if (image !== undefined) content.push(image);
  }

  // Images must precede the command block for skill expansion.
  if (dispatch) {
    content.push({ type: "text", text: dispatch.commandText });
  } else if (textWithAttachmentPaths.length > 0) {
    content.push({ type: "text", text: textWithAttachmentPaths });
  }

  return {
    type: "user",
    message: {
      role: "user",
      content,
    },
    parent_tool_use_id: null,
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.uuid === undefined ? {} : { uuid: input.uuid }),
  } satisfies SDKUserMessage;
});

export function isClaudePromptUuid(value: string): value is NonNullable<SDKUserMessage["uuid"]> {
  return /^[^-]+-[^-]+-[^-]+-[^-]+-[^-]+$/.test(value);
}
