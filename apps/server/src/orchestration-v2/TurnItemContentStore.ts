import type { ThreadId, OrchestrationV2TurnItem, TurnItemId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import {
  MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH,
  readToolOutputImage,
  toolOutputImageBlocks,
  toolOutputImages,
} from "@t3tools/shared/toolOutput";
import {
  createDeterministicAttachmentId,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPathById,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import * as ServerConfig from "../config.ts";
import {
  decodeCommandContentFields,
  decodeDynamicToolContentFields,
  decodeStoredContent,
  encodeStoredContent,
  MAX_STORED_ITEM_BYTES,
  previewContentFields,
  serializedJsonBytesUpTo,
  storedFields,
  type DynamicToolItem,
  type ToolItem,
} from "./TurnItemContentCodec.ts";
import { stripUnservedToolOutputImageBytes } from "./toolOutputImageBytes.ts";

const encoder = new TextEncoder();
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export class TurnItemContentStoreError extends Schema.TaggedError<TurnItemContentStoreError>()(
  "TurnItemContentStoreError",
  {
    threadId: Schema.String,
    itemId: Schema.String,
    operation: Schema.Literals(["store", "read"]),
    reason: Schema.Literals([
      "invalid-content",
      "invalid-reference",
      "content-missing",
      "file-access",
      "content-too-large",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} stored content for turn item ${this.itemId}.`;
  }
}

export class TurnItemContentStore extends Context.Service<
  TurnItemContentStore,
  {
    readonly store: (
      item: OrchestrationV2TurnItem,
    ) => Effect.Effect<OrchestrationV2TurnItem, TurnItemContentStoreError>;
    readonly storeForCommit: (item: OrchestrationV2TurnItem) => Effect.Effect<
      {
        readonly item: OrchestrationV2TurnItem;
        readonly createdAttachmentIds: ReadonlyArray<string>;
      },
      TurnItemContentStoreError
    >;
    readonly removeNewAttachments: (attachmentIds: ReadonlyArray<string>) => Effect.Effect<void>;
    readonly read: (
      item: OrchestrationV2TurnItem,
      options?: { readonly includeImageData?: boolean },
    ) => Effect.Effect<OrchestrationV2TurnItem, TurnItemContentStoreError>;
  }
>()("t3/orchestration-v2/TurnItemContentStore") {}

export function needsTurnItemContentRead(item: OrchestrationV2TurnItem): boolean {
  if (item.type === "command_execution") return item.contentRef !== undefined;
  if (item.type !== "dynamic_tool") return false;
  return (
    item.contentRef !== undefined ||
    toolOutputImages(item.output).some((image) => image.attachmentId !== undefined)
  );
}

function replaceImageWithAttachment(
  block: unknown,
  attachmentId: string,
  sizeBytes: number,
): unknown {
  if (!Predicate.isObject(block)) return block;
  const source = Predicate.isObject(block.source) ? block.source : undefined;
  if (source !== undefined && typeof source.data === "string") {
    const { data: _data, ...rest } = source;
    return {
      ...block,
      source: { ...rest, attachmentId, sizeBytes },
    };
  }
  if (typeof block.data === "string") {
    const { data: _data, ...rest } = block;
    return { ...rest, attachmentId, sizeBytes };
  }
  return block;
}

function restoreImageData(block: unknown, data: string): unknown {
  if (!Predicate.isObject(block)) return block;
  const source = Predicate.isObject(block.source) ? block.source : undefined;
  if (source !== undefined) {
    const { attachmentId: _attachmentId, sizeBytes: _sizeBytes, ...rest } = source;
    return { ...block, source: { ...rest, data } };
  }
  const { attachmentId: _attachmentId, sizeBytes: _sizeBytes, ...rest } = block;
  return { ...rest, data };
}

function replaceImageBlocks(output: unknown, replacements: ReadonlyMap<unknown, unknown>): unknown {
  if (Array.isArray(output)) {
    return output.map((block) => replacements.get(block) ?? block);
  }
  if (Predicate.isObject(output) && Array.isArray(output.content)) {
    let changed = false;
    const content = output.content.map((block) => {
      const replacement = replacements.get(block);
      changed ||= replacement !== undefined;
      return replacement ?? block;
    });
    return changed ? { ...output, content } : output;
  }
  return replacements.get(output) ?? output;
}

export const layer: Layer.Layer<
  TurnItemContentStore,
  never,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig
> = Layer.effect(
  TurnItemContentStore,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;

    const failure = (input: {
      readonly threadId: ThreadId;
      readonly itemId: TurnItemId;
      readonly operation: "store" | "read";
      readonly reason: TurnItemContentStoreError["reason"];
      readonly cause?: unknown;
    }) =>
      new TurnItemContentStoreError({
        threadId: input.threadId,
        itemId: input.itemId,
        operation: input.operation,
        reason: input.reason,
        ...(input.cause === undefined ? {} : { cause: input.cause }),
      });

    const filePathForAttachment = (attachmentId: string) =>
      resolveAttachmentRelativePath({
        attachmentsDir: config.attachmentsDir,
        relativePath: `${attachmentId}.bin`,
      });

    const removeNewAttachments = Effect.fn("TurnItemContentStore.removeNewAttachments")(function* (
      attachmentIds: ReadonlyArray<string>,
    ) {
      for (const attachmentId of new Set(attachmentIds)) {
        const filePath = filePathForAttachment(attachmentId);
        if (filePath !== null) {
          yield* fileSystem.remove(filePath).pipe(Effect.ignore({ log: true }));
        }
      }
    });

    const writeBytes = Effect.fn("TurnItemContentStore.writeBytes")(function* (input: {
      readonly filePath: string;
      readonly bytes: Uint8Array;
    }) {
      const directory = path.dirname(input.filePath);
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      if (yield* fileSystem.exists(input.filePath)) return false;
      const temporaryDirectory = yield* fileSystem.makeTempDirectory({
        directory,
        prefix: `${path.basename(input.filePath)}.`,
      });
      const temporaryPath = path.join(temporaryDirectory, "contents.part");
      const write = fileSystem
        .writeFile(temporaryPath, input.bytes)
        .pipe(Effect.andThen(fileSystem.rename(temporaryPath, input.filePath)), Effect.as(true));
      return yield* write.pipe(
        Effect.catch((cause) =>
          fileSystem
            .exists(input.filePath)
            .pipe(
              Effect.flatMap((exists) => (exists ? Effect.succeed(false) : Effect.fail(cause))),
            ),
        ),
        Effect.ensuring(
          fileSystem
            .remove(temporaryDirectory, { recursive: true })
            .pipe(Effect.ignore({ log: true })),
        ),
      );
    });

    const attachmentIdForBytes = Effect.fn("TurnItemContentStore.attachmentIdForBytes")(
      function* (input: {
        readonly threadId: ThreadId;
        readonly itemId: TurnItemId;
        readonly operation: "store";
        readonly bytes: Uint8Array;
      }) {
        const digest = yield* crypto.digest("SHA-256", input.bytes).pipe(
          Effect.mapError((cause) =>
            failure({
              threadId: input.threadId,
              itemId: input.itemId,
              operation: input.operation,
              reason: "file-access",
              cause,
            }),
          ),
        );
        const attachmentId = createDeterministicAttachmentId(input.threadId, Hex.encode(digest));
        if (attachmentId === null) {
          return yield* failure({
            threadId: input.threadId,
            itemId: input.itemId,
            operation: input.operation,
            reason: "invalid-reference",
          });
        }
        return attachmentId;
      },
    );

    const storeImageBlocks = Effect.fn("TurnItemContentStore.storeImageBlocks")(function* (
      item: DynamicToolItem,
      createdAttachmentIds: Array<string>,
    ) {
      const blocks = toolOutputImageBlocks(item.output);
      const replacements = new Map<unknown, unknown>();
      for (const block of blocks) {
        const image = readToolOutputImage(block);
        if (
          image?.data === undefined ||
          image.data.length > MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH ||
          image.attachmentId !== undefined
        ) {
          continue;
        }
        const bytes = Buffer.from(image.data, "base64");
        const attachmentId = yield* attachmentIdForBytes({
          threadId: item.threadId,
          itemId: item.id,
          operation: "store",
          bytes,
        });
        const filePath = filePathForAttachment(attachmentId);
        if (filePath === null) {
          return yield* failure({
            threadId: item.threadId,
            itemId: item.id,
            operation: "store",
            reason: "invalid-reference",
          });
        }
        const created = yield* writeBytes({ filePath, bytes }).pipe(
          Effect.mapError((cause) =>
            failure({
              threadId: item.threadId,
              itemId: item.id,
              operation: "store",
              reason: "file-access",
              cause,
            }),
          ),
        );
        if (created) createdAttachmentIds.push(attachmentId);
        replacements.set(block, replaceImageWithAttachment(block, attachmentId, bytes.byteLength));
      }
      if (replacements.size === 0 || item.output === undefined) return item;
      const output = replaceImageBlocks(item.output, replacements);
      return output === item.output ? item : { ...item, output };
    });

    const storeContent = Effect.fn("TurnItemContentStore.storeContent")(function* (
      original: OrchestrationV2TurnItem,
      createdAttachmentIds: Array<string>,
    ) {
      if (original.type !== "command_execution" && original.type !== "dynamic_tool") {
        return original;
      }
      const stripped = stripUnservedToolOutputImageBytes(original);
      if (stripped.type !== "command_execution" && stripped.type !== "dynamic_tool") {
        return stripped;
      }
      const prepared: ToolItem =
        stripped.type === "dynamic_tool"
          ? yield* storeImageBlocks(stripped, createdAttachmentIds)
          : stripped;
      if (serializedJsonBytesUpTo(prepared, MAX_STORED_ITEM_BYTES) <= MAX_STORED_ITEM_BYTES) {
        return prepared;
      }
      if (prepared.contentRef !== undefined) {
        return yield* failure({
          threadId: prepared.threadId,
          itemId: prepared.id,
          operation: "store",
          reason: "content-too-large",
        });
      }

      const serialized = yield* encodeStoredContent(storedFields(prepared)).pipe(
        Effect.mapError((cause) =>
          failure({
            threadId: prepared.threadId,
            itemId: prepared.id,
            operation: "store",
            reason: "invalid-content",
            cause,
          }),
        ),
      );
      const bytes = encoder.encode(serialized);
      const attachmentId = yield* attachmentIdForBytes({
        threadId: prepared.threadId,
        itemId: prepared.id,
        operation: "store",
        bytes,
      });
      const filePath = filePathForAttachment(attachmentId);
      if (filePath === null) {
        return yield* failure({
          threadId: prepared.threadId,
          itemId: prepared.id,
          operation: "store",
          reason: "invalid-reference",
        });
      }
      const created = yield* writeBytes({ filePath, bytes }).pipe(
        Effect.mapError((cause) =>
          failure({
            threadId: prepared.threadId,
            itemId: prepared.id,
            operation: "store",
            reason: "file-access",
            cause,
          }),
        ),
      );
      if (created) createdAttachmentIds.push(attachmentId);

      const attachmentIds =
        prepared.type === "dynamic_tool"
          ? Array.from(
              new Set(
                toolOutputImages(prepared.output).flatMap((image) =>
                  image.attachmentId === undefined ? [] : [image.attachmentId],
                ),
              ),
            )
          : [];

      const contentRef = {
        attachmentId,
        sizeBytes: bytes.byteLength,
        ...(attachmentIds.length === 0 ? {} : { attachmentIds }),
      };
      const firstPreview = previewContentFields(prepared, contentRef);
      const transcriptItem = {
        ...stripped,
        ...(firstPreview.outputIndicatesFailure === undefined
          ? {}
          : { outputIndicatesFailure: firstPreview.outputIndicatesFailure }),
      };
      const bounded = previewContentFields(prepared, {
        ...contentRef,
        transcriptItemBytes: Buffer.byteLength(encodeUnknownJson(transcriptItem), "utf8"),
      });
      if (serializedJsonBytesUpTo(bounded, MAX_STORED_ITEM_BYTES) > MAX_STORED_ITEM_BYTES) {
        return yield* failure({
          threadId: prepared.threadId,
          itemId: prepared.id,
          operation: "store",
          reason: "content-too-large",
        });
      }
      return bounded;
    });

    const storeForCommit: TurnItemContentStore["Service"]["storeForCommit"] = Effect.fn(
      "TurnItemContentStore.storeForCommit",
    )(function* (item) {
      const createdAttachmentIds: Array<string> = [];
      const stored = yield* storeContent(item, createdAttachmentIds).pipe(
        Effect.map((storedItem) => ({ item: storedItem, createdAttachmentIds })),
        Effect.catchCause((cause) =>
          removeNewAttachments(createdAttachmentIds).pipe(Effect.andThen(Effect.failCause(cause))),
        ),
      );
      return stored;
    });

    const store: TurnItemContentStore["Service"]["store"] = (item) =>
      storeForCommit(item).pipe(Effect.map((stored) => stored.item));

    const readAttachment = Effect.fn("TurnItemContentStore.readAttachment")(function* (input: {
      readonly threadId: ThreadId;
      readonly itemId: TurnItemId;
      readonly attachmentId: string;
    }) {
      const ownerSegment = toSafeThreadAttachmentSegment(input.threadId);
      if (
        ownerSegment === null ||
        parseThreadSegmentFromAttachmentId(input.attachmentId) !== ownerSegment
      ) {
        return yield* failure({
          threadId: input.threadId,
          itemId: input.itemId,
          operation: "read",
          reason: "invalid-reference",
        });
      }
      const filePath = resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId: input.attachmentId,
      });
      if (filePath === null) {
        return yield* failure({
          threadId: input.threadId,
          itemId: input.itemId,
          operation: "read",
          reason: "content-missing",
        });
      }
      return yield* fileSystem.readFile(filePath).pipe(
        Effect.mapError((cause) =>
          failure({
            threadId: input.threadId,
            itemId: input.itemId,
            operation: "read",
            reason: "file-access",
            cause,
          }),
        ),
      );
    });

    const restoreImages = Effect.fn("TurnItemContentStore.restoreImages")(function* (
      item: DynamicToolItem,
      value: unknown,
    ): Effect.fn.Return<unknown, TurnItemContentStoreError> {
      const replacements = new Map<unknown, unknown>();
      for (const block of toolOutputImageBlocks(value)) {
        const image = readToolOutputImage(block);
        if (image?.attachmentId === undefined) continue;
        const bytes = yield* readAttachment({
          threadId: item.threadId,
          itemId: item.id,
          attachmentId: image.attachmentId,
        });
        if (image.sizeBytes !== undefined && image.sizeBytes !== bytes.byteLength) {
          return yield* failure({
            threadId: item.threadId,
            itemId: item.id,
            operation: "read",
            reason: "invalid-content",
          });
        }
        replacements.set(block, restoreImageData(block, Buffer.from(bytes).toString("base64")));
      }
      return replaceImageBlocks(value, replacements);
    });

    const read: TurnItemContentStore["Service"]["read"] = Effect.fn("TurnItemContentStore.read")(
      function* (original, options) {
        let item: OrchestrationV2TurnItem = original;
        if (
          (item.type === "command_execution" || item.type === "dynamic_tool") &&
          item.contentRef !== undefined
        ) {
          const bytes = yield* readAttachment({
            threadId: item.threadId,
            itemId: item.id,
            attachmentId: item.contentRef.attachmentId,
          });
          if (bytes.byteLength !== item.contentRef.sizeBytes) {
            return yield* failure({
              threadId: item.threadId,
              itemId: item.id,
              operation: "read",
              reason: "invalid-content",
            });
          }
          const parsed = yield* decodeStoredContent(Buffer.from(bytes).toString("utf8")).pipe(
            Effect.mapError((cause) =>
              failure({
                threadId: item.threadId,
                itemId: item.id,
                operation: "read",
                reason: "invalid-content",
                cause,
              }),
            ),
          );
          const fields = parsed.fields;
          if (item.type === "command_execution") {
            const commandFields = yield* decodeCommandContentFields(fields).pipe(
              Effect.mapError((cause) =>
                failure({
                  threadId: item.threadId,
                  itemId: item.id,
                  operation: "read",
                  reason: "invalid-content",
                  cause,
                }),
              ),
            );
            const { contentRef: _contentRef, ...command } = item;
            item = {
              ...command,
              input: commandFields.input,
              title: commandFields.title,
              ...(commandFields.output === undefined ? {} : { output: commandFields.output }),
            };
          } else {
            const dynamicFields = yield* decodeDynamicToolContentFields(fields).pipe(
              Effect.mapError((cause) =>
                failure({
                  threadId: item.threadId,
                  itemId: item.id,
                  operation: "read",
                  reason: "invalid-content",
                  cause,
                }),
              ),
            );
            const { contentRef: _contentRef, ...tool } = item;
            item = {
              ...tool,
              input: dynamicFields.input,
              title: dynamicFields.title,
              toolName: dynamicFields.toolName,
              ...(dynamicFields.viewedImagePath === undefined
                ? {}
                : { viewedImagePath: dynamicFields.viewedImagePath }),
              ...(dynamicFields.output === undefined ? {} : { output: dynamicFields.output }),
            };
          }
        }

        if (
          options?.includeImageData === true &&
          item.type === "dynamic_tool" &&
          item.output !== undefined
        ) {
          return { ...item, output: yield* restoreImages(item, item.output) };
        }
        return item;
      },
    );

    return TurnItemContentStore.of({ store, storeForCommit, removeNewAttachments, read });
  }),
);
