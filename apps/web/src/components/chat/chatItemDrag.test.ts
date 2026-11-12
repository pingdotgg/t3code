import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import type { DragEvent } from "react";

import {
  attachmentDragProps,
  CHAT_ITEM_DRAG_TYPE,
  chatItemClipboardData,
  chatItemDropError,
  fileReferenceDragProps,
  readChatItemDrop,
} from "./chatItemDrag";
import { readPastedComposerContext } from "../composerInlineTokenPaste";

const environmentId = EnvironmentId.make("source");

function transfer() {
  const strings = new Map<string, string>();
  const files: File[] = [];
  return {
    files,
    effectAllowed: "none",
    items: { add: (file: File) => files.push(file) },
    clearData: () => strings.clear(),
    setData: (format: string, value: string) => strings.set(format, value),
    getData: (format: string) => strings.get(format) ?? "",
  };
}

function start(props: ReturnType<typeof fileReferenceDragProps>, data = transfer()) {
  if (!props.onDragStartCapture) throw new Error("Item cannot be dragged");
  let stopped = false;
  props.onDragStartCapture({
    dataTransfer: data,
    stopPropagation: () => {
      stopped = true;
    },
  } as unknown as DragEvent<HTMLElement>);
  expect(stopped).toBe(true);
  expect(data.effectAllowed).toBe("copy");
  return data;
}

describe("chat item dragging", () => {
  it.each([
    ["/source/project", "docs/My File.md", "/source/project/docs/My File.md"],
    ["C:\\source", "docs/file.md", "C:\\source\\docs\\file.md"],
    ["/other/project", "/original/file.md", "/original/file.md"],
  ])("keeps the source location when dragging from %s", (cwd, path, resolved) => {
    const data = start(fileReferenceDragProps(environmentId, path, cwd));
    const item = readChatItemDrop(data);
    expect(item).toEqual({ kind: "mention", environmentId, path: resolved });
    expect(item && chatItemDropError(item, environmentId)).toBeNull();
    expect(item && chatItemDropError(item, EnvironmentId.make("other"))).toContain("same server");
  });

  it.each(["image", "file"] as const)(
    "carries available %s contents without consuming the source file",
    (type) => {
      const file = new File(["original bytes"], type === "image" ? "photo.png" : "notes.txt", {
        type: type === "image" ? "image/png" : "text/plain",
      });
      const attachment = {
        type,
        id: "draft-file",
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        file,
      };
      const data = start(attachmentDragProps(environmentId, attachment));
      expect(readChatItemDrop(data)).toMatchObject({
        kind: "attachment",
        environmentId,
        file,
        record: { kind: type, attachmentId: "draft-file" },
      });
      expect(attachment.file).toBe(file);
    },
  );

  it("imports an uploaded attachment through the existing context format", () => {
    const data = start(
      attachmentDragProps(environmentId, {
        type: "file",
        id: "draft",
        uploadedAttachmentId: "uploaded",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
        file: null,
      }),
    );
    const item = readChatItemDrop(data);
    if (item?.kind !== "attachment") throw new Error("Missing attachment");
    expect(readPastedComposerContext(chatItemClipboardData(item))).toMatchObject({
      source: { environmentId },
      records: [{ attachmentId: "uploaded", kind: "file" }],
    });
    expect(chatItemDropError(item, EnvironmentId.make("other"))).toBeNull();
  });

  it.each([
    "{",
    JSON.stringify({ kind: "mention", environmentId, path: "relative.md" }),
    JSON.stringify({ kind: "attachment", environmentId, record: { kind: "file" } }),
    "x".repeat(65_537),
  ])("rejects malformed or unresolved payloads", (raw) => {
    const data = transfer();
    data.setData(CHAT_ITEM_DRAG_TYPE, raw);
    expect(readChatItemDrop(data)).toBeNull();
  });

  it("does not offer unavailable files or references without a source workspace", () => {
    expect(fileReferenceDragProps(environmentId, "relative.md")).toMatchObject({
      draggable: false,
    });
    expect(
      attachmentDragProps(environmentId, {
        type: "file",
        id: "draft",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
        file: null,
      }),
    ).toMatchObject({ draggable: false });
  });
});
