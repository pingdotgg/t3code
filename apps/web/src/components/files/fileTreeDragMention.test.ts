import { describe, expect, it } from "@effect/vitest";

import { COMPOSER_MENTION_DRAG_TYPE } from "~/components/chat/composerMentionDrag";
import { createFileTreeDragMentionController } from "./fileTreeDragMention.ts";

const makeTransfer = (plainText = "") => {
  const data = new Map<string, string>([["text/plain", plainText]]);
  return {
    setData: (format: string, value: string) => void data.set(format, value),
    getData: (format: string) => data.get(format) ?? "",
    data,
  };
};

const rowNode = (path: string) => ({
  getAttribute: (name: string) => (name === "data-item-path" ? path : null),
});

describe("createFileTreeDragMentionController", () => {
  it("tags a row drag with the mention payload and flags the drag", () => {
    const controller = createFileTreeDragMentionController({ deselect: () => {} });
    const transfer = makeTransfer();
    controller.handleDragStart({
      dataTransfer: transfer,
      composedPath: () => [{}, rowNode("docs/index.md"), {}],
    });
    expect(transfer.getData(COMPOSER_MENTION_DRAG_TYPE)).toBe("[index.md](docs/index.md)");
    expect(controller.isDragInProgress()).toBe(true);
  });

  it("strips the trailing slash from directory rows", () => {
    const controller = createFileTreeDragMentionController({ deselect: () => {} });
    const transfer = makeTransfer();
    controller.handleDragStart({
      dataTransfer: transfer,
      composedPath: () => [rowNode("docs/architecture/")],
    });
    expect(transfer.getData(COMPOSER_MENTION_DRAG_TYPE)).toBe("[architecture](docs/architecture)");
  });

  it("does not tag drags of selected text from the panel chrome", () => {
    // Only a drag that originates on a tree row is a mention; dragging a text
    // selection also carries text/plain, and tagging it would drop an invalid
    // pill into the composer.
    const controller = createFileTreeDragMentionController({ deselect: () => {} });
    const transfer = makeTransfer("selected text");
    controller.handleDragStart({ dataTransfer: transfer, composedPath: () => [{}] });
    expect(transfer.data.has(COMPOSER_MENTION_DRAG_TYPE)).toBe(false);
    expect(controller.isDragInProgress()).toBe(false);
  });

  it("ignores drags that carry no row path", () => {
    const controller = createFileTreeDragMentionController({ deselect: () => {} });
    const transfer = makeTransfer();
    controller.handleDragStart({ dataTransfer: transfer, composedPath: () => [{}] });
    expect(transfer.data.has(COMPOSER_MENTION_DRAG_TYPE)).toBe(false);
    expect(controller.isDragInProgress()).toBe(false);
  });

  it("deselects the dragged row exactly once when the drag ends", () => {
    const deselected: Array<string> = [];
    const controller = createFileTreeDragMentionController({
      deselect: (path) => deselected.push(path),
    });
    controller.handleDragStart({
      dataTransfer: makeTransfer(),
      composedPath: () => [rowNode("src/app.ts")],
    });
    controller.handleDragEnd();
    controller.handleDragEnd();
    expect(deselected).toEqual(["src/app.ts"]);
    expect(controller.isDragInProgress()).toBe(false);
  });

  it("drags the whole selection when the dragged row is part of it", () => {
    const deselected: Array<string> = [];
    const controller = createFileTreeDragMentionController({
      deselect: (path) => deselected.push(path),
    });
    controller.handleSelectionChange(["docs/index.md", "docs/api.md", "src/app.ts"]);
    const transfer = makeTransfer();
    controller.handleDragStart({
      dataTransfer: transfer,
      composedPath: () => [rowNode("docs/api.md")],
    });
    expect(transfer.getData(COMPOSER_MENTION_DRAG_TYPE)).toBe(
      "[index.md](docs/index.md) [api.md](docs/api.md) [app.ts](src/app.ts)",
    );
    controller.handleDragEnd();
    expect(deselected).toEqual(["docs/index.md", "docs/api.md", "src/app.ts"]);
  });

  it("drags only the row under the cursor when it is outside the selection", () => {
    const controller = createFileTreeDragMentionController({ deselect: () => {} });
    controller.handleSelectionChange(["docs/index.md"]);
    const transfer = makeTransfer();
    controller.handleDragStart({
      dataTransfer: transfer,
      composedPath: () => [rowNode("src/app.ts")],
    });
    expect(transfer.getData(COMPOSER_MENTION_DRAG_TYPE)).toBe("[app.ts](src/app.ts)");
  });

  it("does not deselect anything when no drag was started", () => {
    const deselected: Array<string> = [];
    const controller = createFileTreeDragMentionController({
      deselect: (path) => deselected.push(path),
    });
    controller.handleDragEnd();
    expect(deselected).toEqual([]);
  });
});
