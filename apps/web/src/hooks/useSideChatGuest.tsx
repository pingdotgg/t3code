import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { MessageCircleQuestionIcon } from "lucide-react";
import { type RefObject, useEffect } from "react";

import type { ChatComposerHandle } from "../components/chat/ChatComposer";
import type { ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
import {
  eventPathContainsSelector,
  TYPE_TO_FOCUS_EDITABLE_SELECTOR,
  TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR,
} from "../components/chat/composerFocusRedirect";
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

  const focus = () => {
    if (parentKey !== null) useSideChatFocusStore.getState().focus(parentKey, threadId);
  };
  const release = () => {
    if (parentKey !== null) useSideChatFocusStore.getState().release(parentKey, threadId);
  };

  // The composer remounts when it moves between the parent's slot and the panel
  // (maximizing), so it takes the keyboard on every move, not just on focus.
  const composerPlace = !focused ? null : sideChat?.composerSlot ? "slot" : "panel";
  useEffect(() => {
    if (composerPlace === null) return;
    const frame = requestAnimationFrame(() => composerRef.current?.focusAtEnd());
    return () => cancelAnimationFrame(frame);
  }, [composerPlace, composerRef]);

  // Escape goes back to main even after focus leaves the composer. This listens
  // in the bubble phase, after the editor, menus and dialogs claim their own
  // Escape, and leaves fields that use Escape themselves alone.
  useEffect(() => {
    if (!focused || parentKey === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (eventPathContainsSelector(event, TYPE_TO_FOCUS_EDITABLE_SELECTOR)) return;
      if (document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR)) return;
      // A fullscreen app takes Escape to leave fullscreen.
      if (document.querySelector("[data-mcp-app-fullscreen]")) return;
      event.preventDefault();
      useSideChatFocusStore.getState().release(parentKey, threadId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focused, parentKey, threadId]);

  // The parent's own questions stay one Escape away.
  const parentShell = useThreadShell(parentRef);
  // A delegated child's request is asked on the parent too.
  const parentAwaitingAnswer =
    parentShell?.hasPendingApprovals === true ||
    parentShell?.hasPendingUserInput === true ||
    (parentShell?.pendingSubagentRequest ?? null) !== null;
  const bannerItems = ((): ComposerBannerStackItem[] => {
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
  })();

  const composerProps =
    sideChat === undefined
      ? {}
      : {
          idlePlaceholder: "Ask on the side. Esc goes back to main",
          onEscape: () => {
            release();
            return true;
          },
        };

  return { focus, bannerItems, composerProps };
}
