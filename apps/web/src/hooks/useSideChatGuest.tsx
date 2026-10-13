import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { MessageCircleQuestionIcon } from "lucide-react";
import { type RefObject, useCallback, useEffect, useMemo } from "react";

import type { ChatComposerHandle } from "../components/chat/ChatComposer";
import type { ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
import { Button } from "../components/ui/button";
import { useSideChatFocusStore } from "../sideChatStore";
import { useThreadShell } from "../state/entities";

/** How a parent thread shows one of its side chats in its right panel. */
export interface SideChatEmbedding {
  readonly parentRef: ScopedThreadRef;
  /** It has the parent's composer. */
  readonly focused: boolean;
  /** Where its composer renders while focused; null keeps it in the panel. */
  readonly composerSlot: HTMLElement | null;
}

/**
 * A side chat's side of the shared composer: taking and returning focus, and
 * the banners that say where messages go.
 */
export function useSideChatGuest(input: {
  readonly sideChat: SideChatEmbedding | undefined;
  readonly threadId: ThreadId;
  readonly composerRef: RefObject<ChatComposerHandle | null>;
  readonly composerBannerItems: ComposerBannerStackItem[];
}) {
  const { sideChat, threadId, composerRef, composerBannerItems } = input;
  const parentRef = sideChat?.parentRef ?? null;
  const parentKey = parentRef === null ? null : scopedThreadKey(parentRef);
  const focused = sideChat?.focused === true;

  const focus = useCallback(() => {
    if (parentKey !== null) useSideChatFocusStore.getState().focus(parentKey, threadId);
  }, [parentKey, threadId]);
  const release = useCallback(() => {
    if (parentKey !== null) useSideChatFocusStore.getState().release(parentKey, threadId);
  }, [parentKey, threadId]);

  // The composer remounts when it moves between the parent's slot and the panel
  // (maximizing), so it takes the keyboard on every move, not just on focus.
  const composerPlace = !focused ? null : sideChat?.composerSlot ? "slot" : "panel";
  useEffect(() => {
    if (composerPlace === null) return;
    const frame = requestAnimationFrame(() => composerRef.current?.focusAtEnd());
    return () => cancelAnimationFrame(frame);
  }, [composerPlace, composerRef]);

  // The parent's own questions stay one Escape away.
  const parentShell = useThreadShell(parentRef);
  const parentAwaitingAnswer =
    parentShell?.hasPendingApprovals === true || parentShell?.hasPendingUserInput === true;
  const bannerItems = useMemo<ComposerBannerStackItem[]>(() => {
    if (sideChat === undefined) return composerBannerItems;
    const sideItems: ComposerBannerStackItem[] = [];
    if (parentAwaitingAnswer) {
      sideItems.push({
        id: "side-chat:parent-waiting",
        variant: "warning",
        priority: "activity",
        icon: <MessageCircleQuestionIcon />,
        title: "The main thread is waiting on you",
        actions: (
          <Button size="xs" variant="ghost" onClick={release}>
            Answer it
          </Button>
        ),
      });
    }
    sideItems.push({
      id: "side-chat",
      variant: "info",
      priority: "activity",
      icon: <MessageCircleQuestionIcon />,
      title: (
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 font-medium text-foreground">Side chat</span>
          <span className="min-w-0 truncate font-normal text-muted-foreground">
            Esc goes back to main
          </span>
        </span>
      ),
      dismissLabel: "Back to main",
      onDismiss: release,
    });
    return [...sideItems, ...composerBannerItems];
  }, [composerBannerItems, parentAwaitingAnswer, release, sideChat]);

  const composerProps = useMemo(
    () =>
      sideChat === undefined
        ? {}
        : {
            idlePlaceholder: "Ask on the side. Esc goes back to main",
            onEscape: () => {
              release();
              return true;
            },
          },
    [release, sideChat],
  );

  return { focus, bannerItems, composerProps };
}
