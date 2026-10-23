import { describe, expect, it } from "@effect/vitest";

import {
  COMPOSER_MENTION_DRAG_TYPE,
  type ComposerMentionDropHost,
  makeComposerMentionDragHandlers,
} from "./composerMentionDrag.ts";

const makeDragEvent = (options?: {
  mention?: string;
  types?: ReadonlyArray<string>;
  format?: string;
}) => {
  const mention = options?.mention ?? "[index.md](docs/index.md)";
  const format = options?.format ?? COMPOSER_MENTION_DRAG_TYPE;
  const calls: Array<string> = [];
  const event = {
    dataTransfer: {
      types: options?.types ?? [format, "text/plain"],
      getData: (requested: string) => (requested === format ? mention : ""),
      dropEffect: "none",
    },
    nativeEvent: {
      stopPropagation: () => void calls.push("nativeStopPropagation"),
    },
    preventDefault: () => void calls.push("preventDefault"),
    stopPropagation: () => void calls.push("stopPropagation"),
  };
  return { event, calls };
};

const makeHost = (insertResult = true) => {
  const log: Array<string> = [];
  const host: ComposerMentionDropHost = {
    insertMentionAtEnd: (text) => {
      log.push(`insert:${text}`);
      return insertResult;
    },
    insertPullRequestAtEnd: (pullRequest) => {
      log.push(`pr:${pullRequest.number}`);
      return insertResult;
    },
    setDragActive: (active) => void log.push(`active:${active}`),
    onInsertRejected: () => void log.push("rejected"),
  };
  return { host, log };
};

describe("makeComposerMentionDragHandlers", () => {
  it("leaves drags without the mention payload alone", () => {
    const { host, log } = makeHost();
    const handlers = makeComposerMentionDragHandlers(host);
    const { event, calls } = makeDragEvent({ types: ["Files"] });
    handlers.onDragEnter(event);
    handlers.onDragOver(event);
    handlers.onDrop(event);
    expect(calls).toEqual([]);
    expect(log).toEqual([]);
  });

  it("stops the native event too, not just the synthetic one", () => {
    // React's stopPropagation only halts synthetic dispatch; without the
    // native stop, the editor's own DOM listeners process the drop and sync
    // their stale state back over the inserted mention.
    const { host } = makeHost();
    const handlers = makeComposerMentionDragHandlers(host);
    const { event, calls } = makeDragEvent();
    handlers.onDrop(event);
    expect(calls).toContain("preventDefault");
    expect(calls).toContain("stopPropagation");
    expect(calls).toContain("nativeStopPropagation");
  });

  it('answers dragover with the "move" effect the tree allows', () => {
    // Naming an effect outside the source's effectAllowed makes the browser
    // cancel the drop without ever firing it.
    const { host } = makeHost();
    const handlers = makeComposerMentionDragHandlers(host);
    const { event } = makeDragEvent();
    handlers.onDragOver(event);
    expect(event.dataTransfer.dropEffect).toBe("move");
  });
});
