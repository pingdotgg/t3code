import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { chapterTitleFromText, useChatChapterStore } from "./chatChapterStore";

const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));

const message = (id: string, text: string, createdAt: string) => ({
  id: MessageId.make(id),
  text,
  createdAt,
});

const chapterTitles = () =>
  (useChatChapterStore.getState().chaptersByThreadKey[scopedThreadKey(threadRef)] ?? []).map(
    (chapter) => chapter.title,
  );

beforeEach(() => {
  useChatChapterStore.setState({ chaptersByThreadKey: {}, revealRequest: null });
});

describe("chapterTitleFromText", () => {
  it("uses the first non-empty line without a heading mark", () => {
    expect(chapterTitleFromText("\n\n## Plan   for  the refactor\nmore detail")).toBe(
      "Plan for the refactor",
    );
  });

  it("names an empty message and cuts a long title to 120 characters", () => {
    expect(chapterTitleFromText("   \n ")).toBe("Untitled message");
    expect(chapterTitleFromText("a".repeat(200))).toHaveLength(120);
  });
});

describe("chat chapters", () => {
  it("lists pins in conversation order and unpins on a second toggle", () => {
    const { togglePin } = useChatChapterStore.getState();
    togglePin(threadRef, message("m2", "second", "2026-01-02T00:00:00.000Z"));
    togglePin(threadRef, message("m1", "first", "2026-01-01T00:00:00.000Z"));
    expect(chapterTitles()).toEqual(["first", "second"]);

    togglePin(threadRef, message("m1", "first", "2026-01-01T00:00:00.000Z"));
    expect(chapterTitles()).toEqual(["second"]);
  });

  it("removes the thread entry once its last chapter is unpinned", () => {
    const { togglePin, unpin } = useChatChapterStore.getState();
    togglePin(threadRef, message("m1", "only", "2026-01-01T00:00:00.000Z"));
    unpin(threadRef, MessageId.make("m1"));
    expect(useChatChapterStore.getState().chaptersByThreadKey).toEqual({});
  });

  it("asks the timeline for a fresh reveal each time the same chapter is chosen", () => {
    const { requestReveal } = useChatChapterStore.getState();
    requestReveal(threadRef, MessageId.make("m1"));
    const first = useChatChapterStore.getState().revealRequest;
    requestReveal(threadRef, MessageId.make("m1"));
    const second = useChatChapterStore.getState().revealRequest;
    expect(first?.messageId).toBe(MessageId.make("m1"));
    expect(second?.nonce).toBe((first?.nonce ?? 0) + 1);

    useChatChapterStore.getState().unpin(threadRef, MessageId.make("m1"));
    requestReveal(threadRef, MessageId.make("m2"));
    expect(useChatChapterStore.getState().revealRequest?.nonce).toBe((second?.nonce ?? 0) + 1);
  });

  it("clears a matching reveal request when the chapter is unpinned", () => {
    const { togglePin, requestReveal, unpin } = useChatChapterStore.getState();
    togglePin(threadRef, message("m1", "first", "2026-01-01T00:00:00.000Z"));
    requestReveal(threadRef, MessageId.make("m1"));
    expect(useChatChapterStore.getState().revealRequest?.messageId).toBe(MessageId.make("m1"));

    unpin(threadRef, MessageId.make("m1"));
    expect(useChatChapterStore.getState().revealRequest).toBeNull();
  });

  it("preserves an unrelated reveal request when another chapter is unpinned", () => {
    const { togglePin, requestReveal, unpin } = useChatChapterStore.getState();
    togglePin(threadRef, message("m1", "first", "2026-01-01T00:00:00.000Z"));
    togglePin(threadRef, message("m2", "second", "2026-01-02T00:00:00.000Z"));
    requestReveal(threadRef, MessageId.make("m2"));

    unpin(threadRef, MessageId.make("m1"));
    expect(useChatChapterStore.getState().revealRequest?.messageId).toBe(MessageId.make("m2"));
  });
});
