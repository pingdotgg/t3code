import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { MessageId, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "./lib/storage";

const CHAPTER_STORAGE_KEY = "t3code:chapters:v1";
const CHAPTER_TITLE_MAX_LENGTH = 120;
const NO_CHAPTERS: readonly ChatChapter[] = [];

interface ChatChapter {
  readonly messageId: MessageId;
  /** Snapshot from pin time, so the list still names a message whose history is not loaded. */
  readonly title: string;
  readonly createdAt: string;
}

interface ChapterRevealRequest {
  readonly threadKey: string;
  readonly messageId: MessageId;
  /** Lets the same chapter be picked again after the timeline scrolled away. */
  readonly nonce: number;
}

interface ChatChapterStoreState {
  chaptersByThreadKey: Record<string, readonly ChatChapter[]>;
  revealRequest: ChapterRevealRequest | null;
  togglePin: (threadRef: ScopedThreadRef, message: ChapterMessage) => void;
  unpin: (threadRef: ScopedThreadRef, messageId: MessageId) => void;
  requestReveal: (threadRef: ScopedThreadRef, messageId: MessageId) => void;
}

export interface ChapterMessage {
  readonly id: MessageId;
  readonly text: string;
  readonly createdAt: string;
}

/** The message's first line, as the chapter title the chapters menu shows. */
export function chapterTitleFromText(text: string): string {
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const title = (firstLine ?? "")
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (title.length === 0) return "Untitled message";
  if (title.length <= CHAPTER_TITLE_MAX_LENGTH) return title;
  return `${title.slice(0, CHAPTER_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

function createChapterStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

/**
 * Chapters are this device's pins: a pinned message is a chapter, in conversation order. They
 * stay local to this client, so other devices and environments do not see them.
 */
export const useChatChapterStore = create<ChatChapterStoreState>()(
  persist(
    (set) => {
      return {
        chaptersByThreadKey: {},
        revealRequest: null,
        togglePin: (threadRef, message) =>
          set((state) => {
            const threadKey = scopedThreadKey(threadRef);
            const current = state.chaptersByThreadKey[threadKey] ?? NO_CHAPTERS;
            const isPinned = current.some((chapter) => chapter.messageId === message.id);
            const next = isPinned
              ? current.filter((chapter) => chapter.messageId !== message.id)
              : [
                  ...current,
                  {
                    messageId: message.id,
                    title: chapterTitleFromText(message.text),
                    createdAt: message.createdAt,
                  },
                ].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
            const chaptersByThreadKey = { ...state.chaptersByThreadKey };
            if (next.length === 0) delete chaptersByThreadKey[threadKey];
            else chaptersByThreadKey[threadKey] = next;
            const matchesReveal =
              isPinned &&
              state.revealRequest?.threadKey === threadKey &&
              state.revealRequest.messageId === message.id;
            return {
              chaptersByThreadKey,
              ...(matchesReveal ? { revealRequest: null } : {}),
            };
          }),
        unpin: (threadRef, messageId) =>
          set((state) => {
            const threadKey = scopedThreadKey(threadRef);
            const current = state.chaptersByThreadKey[threadKey] ?? NO_CHAPTERS;
            const next = current.filter((chapter) => chapter.messageId !== messageId);
            const chaptersByThreadKey = { ...state.chaptersByThreadKey };
            if (next.length === 0) delete chaptersByThreadKey[threadKey];
            else chaptersByThreadKey[threadKey] = next;
            const matchesReveal =
              state.revealRequest?.threadKey === threadKey &&
              state.revealRequest.messageId === messageId;
            return {
              chaptersByThreadKey,
              ...(matchesReveal ? { revealRequest: null } : {}),
            };
          }),
        requestReveal: (threadRef, messageId) =>
          set((state) => ({
            revealRequest: {
              threadKey: scopedThreadKey(threadRef),
              messageId,
              nonce: (state.revealRequest?.nonce ?? 0) + 1,
            },
          })),
      };
    },
    {
      name: CHAPTER_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(createChapterStorage),
      partialize: (state) => ({ chaptersByThreadKey: state.chaptersByThreadKey }),
    },
  ),
);

export function useThreadChapters(threadRef: ScopedThreadRef | null): readonly ChatChapter[] {
  return useChatChapterStore((state) =>
    threadRef
      ? (state.chaptersByThreadKey[scopedThreadKey(threadRef)] ?? NO_CHAPTERS)
      : NO_CHAPTERS,
  );
}

export function useIsChapterPinned(threadRef: ScopedThreadRef, messageId: MessageId): boolean {
  return useChatChapterStore((state) =>
    (state.chaptersByThreadKey[scopedThreadKey(threadRef)] ?? NO_CHAPTERS).some(
      (chapter) => chapter.messageId === messageId,
    ),
  );
}
