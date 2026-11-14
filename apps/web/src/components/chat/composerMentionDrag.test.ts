import { describe, expect, it } from "@effect/vitest";

import {
  COMPOSER_MENTION_DRAG_TYPE,
  type ComposerMentionDropHost,
  makeComposerMentionDragHandlers,
  writePullRequestDragData,
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
    const { host } = makeHost();
    const handlers = makeComposerMentionDragHandlers(host);
    const { event, calls } = makeDragEvent();
    handlers.onDrop(event);
    expect(calls).toContain("preventDefault");
    expect(calls).toContain("stopPropagation");
    expect(calls).toContain("nativeStopPropagation");
  });

  it('answers dragover with the "move" effect the tree allows', () => {
    const { host } = makeHost();
    const handlers = makeComposerMentionDragHandlers(host);
    const { event } = makeDragEvent();
    handlers.onDragOver(event);
    expect(event.dataTransfer.dropEffect).toBe("move");
  });

  it("drops a PR badge drag as a PR chip, keeping #number and the URL for other targets", () => {
    const data = new Map([["text/html", "<span>122</span>"]]);
    const dataTransfer = {
      get types() {
        return [...data.keys()];
      },
      getData: (format: string) => data.get(format) ?? "",
      setData: (format: string, value: string) => void data.set(format, value),
      clearData: () => data.clear(),
      dropEffect: "none",
    };
    const pullRequest = {
      number: 122,
      url: "https://github.com/pingdotgg/t3code/pull/122",
      title: "Fix sidebar drag",
      headBranch: "fix/sidebar-drag",
      baseBranch: "main",
      state: "open",
      isDraft: false,
    } as const;
    writePullRequestDragData(dataTransfer, pullRequest, pullRequest);
    expect(Object.fromEntries(data)).toMatchObject({
      "text/plain": "#122",
      "text/uri-list": pullRequest.url,
    });
    expect(data.has("text/html")).toBe(false);

    const { host, log } = makeHost();
    makeComposerMentionDragHandlers(host).onDrop({ ...makeDragEvent().event, dataTransfer });
    expect(log).toEqual(["active:false", "pr:122"]);
  });
});
