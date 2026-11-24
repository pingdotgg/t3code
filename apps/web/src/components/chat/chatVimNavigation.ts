import type { LegendListRef } from "@legendapp/list/react";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import type { RefObject } from "react";

import type { ComposerHandleRef } from "~/composerHandleContext";
import type { ChatComposerHandle } from "./ChatComposer";
import { isEditableFocused } from "~/lib/editableFocus";
import { focusAdjacentWorkspaceControl, moveWorkspaceFocus } from "~/lib/workspaceFocus";
import { registerCommands } from "~/shortcuts/dispatcher";
import { useThreadSelectionStore } from "~/threadSelectionStore";
import { TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR } from "./composerFocusRedirect";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { getPageScrollDistancePx, scrollToHistoryOffset } from "./pageScrollController";
import { openVimMessageText } from "./vimMessageText";
import { isVimMotion } from "./vimTextCursor";

export type ChatVimModeName = "INSERT" | "NORMAL" | "VISUAL";
type Landing = "start" | "lastLine" | "viewport";
type MessageScroll = {
  list: LegendListRef;
  destination: Landing;
  animation?: ReturnType<typeof scrollToHistoryOffset>;
};
export interface ChatVimNavigationProps {
  readOnly: boolean;
  listRef: RefObject<LegendListRef | null>;
  navigateTimeline: () => void;
  composerRef: ComposerHandleRef;
  enterVimNormalModeRef: RefObject<((event: KeyboardEvent) => boolean) | null>;
}

const PROTECTED =
  '[role=dialog], [role=alertdialog], [role=menu], [role=listbox], [role=application], [data-terminal-owner], [data-v2-item-type="secret_request"]';
const SOURCE = "[data-vim-message-source]";
const shouldAnimateScroll = () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function isSelectableMessage(row: MessagesTimelineRow | undefined) {
  if (row?.kind === "sent-message") return true;
  if (row?.kind !== "message") return false;
  if (row.message.role === "assistant") return true;
  if (row.message.role !== "user") return false;
  const { attribution, text } = resolveUserMessagePresentation(row.message);
  return attribution === null && replaceComposerContextReferences(text, () => "").trim() !== "";
}

function pageStep(event: KeyboardEvent, mode: ChatVimModeName) {
  if (!event.ctrlKey) {
    if (event.key === " ") return event.shiftKey ? -1 : 1;
    if (event.shiftKey) return 0;
    if (event.key === "PageDown") return 1;
    if (event.key === "PageUp") return -1;
    if (mode !== "NORMAL" || (event.key !== "d" && event.key !== "u")) return 0;
  } else if (event.shiftKey) return 0;
  switch (event.key) {
    case "f":
      return 1;
    case "b":
      return -1;
    case "d":
      return 0.5;
    case "u":
      return -0.5;
    default:
      return 0;
  }
}

export function attachChatVimNavigation(
  button: HTMLButtonElement,
  column: HTMLElement,
  {
    readOnly,
    listRef,
    navigateTimeline,
    composerRef,
    enterVimNormalModeRef,
    focusSidebar,
    leaveSidebar,
  }: ChatVimNavigationProps & {
    focusSidebar: () => void;
    leaveSidebar: (focusChat: () => void) => void;
  },
  showMode: (mode: ChatVimModeName) => void,
  copy: (text: string) => Promise<void>,
) {
  let mode: ChatVimModeName = "INSERT";
  let messageKey: string | null = null;
  let source: HTMLElement | null = null;
  let reader: ReturnType<typeof openVimMessageText> | null = null;
  let savedCursor: ReturnType<typeof openVimMessageText>["cursor"] | undefined;
  let draft: ReturnType<ChatComposerHandle["readSnapshot"]> | null = null;
  let pending: "" | "g" | "y" | "i" | "a" | "yi" | "ya" | "f" | "F" | "t" | "T" = "";
  let landing: Landing | null = null;
  let messageScroll: MessageScroll | null = null;
  let pendingPage: { list: LegendListRef; top: number } | null = null;
  const doc = column.ownerDocument;
  const belongsToChat = (element: Element) => element.closest("[data-chat-column]") === column;
  const reading = (target: EventTarget | null) =>
    target === button ||
    target === doc.body ||
    (target instanceof HTMLElement &&
      belongsToChat(target) &&
      target.matches(`${SOURCE}, [data-workspace-area="conversation"], .messages-timeline-scroll`));
  const visibleBottom = (viewport: DOMRect) =>
    Math.min(
      viewport.bottom,
      button.closest("[data-chat-composer-stack]")?.getBoundingClientRect().top ?? viewport.bottom,
    );
  const isCurrentSource = (element: HTMLElement | null): element is HTMLElement =>
    element !== null &&
    element.isConnected &&
    element.closest<HTMLElement>("[data-timeline-row-id]")?.dataset.timelineRowId === messageKey;
  const markMessage = () => {
    if (mode === "INSERT") return;
    const mounted =
      messageKey === null
        ? null
        : column.querySelector<HTMLElement>(
            `[data-timeline-row-id="${CSS.escape(messageKey)}"] ${SOURCE}`,
          );
    if (source !== mounted) {
      closeReader();
      source?.removeAttribute("data-vim-message");
    }
    source = mounted;
    if (source) {
      source.dataset.vimMessage = mode;
      if (!reader) {
        reader = openVimMessageText(source, savedCursor);
        savedCursor = reader.cursor;
        observer.observe(source, { childList: true, subtree: true, characterData: true });
      }
      if (landing === "lastLine") {
        revealText();
        reader.cursor.lastLine();
      } else if (landing) {
        reader.cursor.setPosition(0);
        const top = listRef.current?.getScrollableNode()?.getBoundingClientRect().top;
        if (landing === "viewport" && top !== undefined && source.getBoundingClientRect().top < top)
          reader.moveToScreenY(top + 12);
      }
      landing = null;
      reader.paint(mode === "VISUAL");
    }
  };
  const rowsObserver = new MutationObserver(() => {
    if (messageKey === null) chooseMessage("current");
    else if (!isCurrentSource(source)) markMessage();
  });
  const selectMessage = (key: string | null, at: Landing = "start", keepScrolling = false) => {
    if (!keepScrolling) cancelMessageScroll();
    if (key !== messageKey) {
      closeReader();
      savedCursor = undefined;
    }
    messageKey = key;
    landing = at;
    markMessage();
  };

  const observer = new MutationObserver((records) => {
    if (isCurrentSource(source)) reader?.onMutation(records, mode === "VISUAL");
  });
  function closeReader() {
    observer.disconnect();
    reader?.close();
    reader = null;
  }
  function setMode(next: ChatVimModeName) {
    const previous = mode;
    mode = next;
    if (next !== previous) interruptPage();
    if (next === "INSERT") {
      closeReader();
      cancelMessageScroll();
      rowsObserver.disconnect();
      source?.removeAttribute("data-vim-message");
      source = null;
      savedCursor = undefined;
      messageKey = null;
      draft = null;
    } else if (isCurrentSource(source)) {
      source.dataset.vimMessage = next;
      reader?.paint(next === "VISUAL");
    }
    column.toggleAttribute("data-vim-navigation", next !== "INSERT");
    pending = "";
    showMode(next);
  }

  function chooseMessage(motion: "current" | "first" | "last" | "next" | "previous") {
    const list = listRef.current;
    if (!list) return;
    const state = list.getState();
    const rows: readonly MessagesTimelineRow[] = state.data;
    const current = messageKey === null ? undefined : state.indexByKey(messageKey);
    let start = current ?? Math.max(0, Math.min(rows.length - 1, state.end));
    let direction = -1;
    if (motion === "first") {
      start = 0;
      direction = 1;
    }
    if (motion === "last") start = rows.length - 1;
    if (motion === "next") {
      start = current === undefined ? start : current + 1;
      direction = 1;
    }
    if (motion === "previous" && current !== undefined) start = current - 1;
    const find = (from: number, step: number) => {
      for (let i = from; i >= 0 && i < rows.length; i += step) {
        const row = rows[i];
        if (isSelectableMessage(row)) return row;
      }
      return null;
    };
    const row = find(start, direction) ?? (motion === "current" ? find(start + 1, 1) : null);
    if (!row) return;

    const destination =
      motion === "current"
        ? "viewport"
        : motion === "last" || motion === "previous"
          ? "lastLine"
          : "start";
    const edge = motion === "first" || motion === "last";
    if (edge && messageKey === row.id && messageScroll?.destination === destination) {
      landing = destination;
      markMessage();
      return;
    }
    const continuing =
      (motion === "next" || motion === "previous") && messageScroll?.destination === destination
        ? messageScroll.animation
        : undefined;
    selectMessage(row.id, destination, !!continuing);
    const scroll = list.getScrollableNode();
    if (!scroll) return;
    const caretRect = () =>
      reader?.caret(mode === "VISUAL")?.getBoundingClientRect() ?? source?.getBoundingClientRect();
    const rect = caretRect();
    const viewport = scroll.getBoundingClientRect();
    const top = viewport.top;
    const bottom = visibleBottom(viewport);
    if (
      rect &&
      rect.height > 0 &&
      rect.top < bottom &&
      (motion === "current" || rect.bottom <= bottom) &&
      (rect.top >= top || (motion === "current" && rect.bottom > top))
    ) {
      if (continuing) cancelMessageScroll();
      return;
    }
    if (continuing) {
      continuing.retarget();
      return;
    }
    if (motion !== "current") {
      const alignStart = destination === "start";
      scrollToMessage(list, scroll, destination, () => {
        if (messageKey === null) return scroll.scrollTop;
        if (source && !isCurrentSource(source)) {
          landing = destination;
          markMessage();
        }
        const cell = caretRect();
        const viewport = scroll.getBoundingClientRect();
        const bottom = visibleBottom(viewport);
        if (cell && cell.height > 0)
          return (
            scroll.scrollTop +
            (alignStart ? cell.top - viewport.top - 16 : cell.bottom - bottom + 12)
          );
        const layout = list.getState();
        const index = layout.indexByKey(messageKey);
        const position = layout.positionByKey(messageKey);
        if (index === undefined || position === undefined)
          return alignStart ? 0 : scroll.scrollHeight;
        return alignStart
          ? position - 16
          : position + (layout.sizeAtIndex(index) ?? 0) - (bottom - viewport.top) + 12;
      });
      return;
    }
    const request: MessageScroll = { list, destination };
    messageScroll = request;
    void list.scrollToKey({ key: row.id, animated: false, viewOffset: 16 }).then(() => {
      if (messageScroll !== request) return;
      messageScroll = null;
      paintText();
    });
  }

  function scrollToMessage(
    list: LegendListRef,
    scroll: HTMLElement,
    destination: Landing,
    readOffset: () => number,
  ) {
    navigateTimeline();
    list.cancelScroll();
    const request: MessageScroll = { list, destination };
    messageScroll = request;
    request.animation = scrollToHistoryOffset(scroll, readOffset, shouldAnimateScroll(), () => {
      if (messageScroll !== request) return;
      messageScroll = null;
      markMessage();
    });
  }

  function cancelMessageScroll() {
    const active = messageScroll;
    messageScroll = null;
    active?.animation?.cancel();
    active?.list.cancelScroll();
  }
  function interruptHistoryScroll() {
    if (!messageScroll?.animation) return;
    const { list } = messageScroll;
    cancelMessageScroll();
    if (mode === "NORMAL") selectVisibleMessage(list);
  }

  const enterNormal = () => {
    if (mode === "INSERT") {
      draft = composerRef.current?.readSnapshot("dom") ?? null;
      rowsObserver.observe(column, {
        subtree: true,
        childList: true,
        attributeFilter: ["data-timeline-row-id"],
      });
    }
    const selection = doc.getSelection();
    if (
      selection &&
      !selection.isCollapsed &&
      column.contains(selection.anchorNode) &&
      column.contains(selection.focusNode)
    )
      selection.removeAllRanges();
    setMode("NORMAL");
    button.focus({ preventScroll: true });
    navigateTimeline();
    chooseMessage("current");
  };
  const leaveNavigation = () => {
    const composer = composerRef.current;
    const saved = draft;
    setMode("INSERT");
    if (readOnly) button.focus({ preventScroll: true });
    else if (composer && saved && composer.readSnapshot().value === saved.value) {
      composer.focusAt(saved.cursor, saved.expandedCursor);
    } else composer?.focusAtEnd();
  };
  const toggle = () => {
    if (mode === "INSERT") enterNormal();
    else if (mode === "VISUAL") setMode("NORMAL");
    else leaveNavigation();
  };
  function offsetToShowCaret(scroll: HTMLElement, rect: DOMRect, requested = scroll.scrollTop) {
    const viewport = scroll.getBoundingClientRect();
    return Math.min(
      scroll.scrollTop + rect.top - viewport.top - 12,
      Math.max(requested, scroll.scrollTop + rect.bottom - visibleBottom(viewport) + 12),
    );
  }
  function paintText({
    pageFromTop,
    smooth = false,
  }: { pageFromTop?: number; smooth?: boolean } = {}) {
    const caret = reader?.paint(mode === "VISUAL");
    const list = listRef.current;
    const scroll = list?.getScrollableNode();
    if (!caret || !list || !scroll) return;
    if (messageScroll?.animation) {
      if (smooth) messageScroll.animation.retarget();
      return;
    }
    const rect = caret.getBoundingClientRect();
    const current = scroll.scrollTop;
    const requested =
      pageFromTop === undefined ? current : (pendingPage?.top ?? current) + rect.top - pageFromTop;
    const top = offsetToShowCaret(scroll, rect, requested);
    if (pageFromTop !== undefined) scrollToPage(list, scroll, top);
    else if (top !== current) {
      if (smooth) {
        scrollToMessage(list, scroll, "viewport", () => {
          const cell = reader?.caret(mode === "VISUAL");
          return cell ? offsetToShowCaret(scroll, cell.getBoundingClientRect()) : scroll.scrollTop;
        });
      } else scroll.scrollTop = top;
    }
  }
  function scrollPage(pages: number) {
    const list = listRef.current;
    const scroll = list?.getScrollableNode();
    if (!list || !scroll) return;
    pending = "";
    navigateTimeline();
    if (messageScroll) cancelMessageScroll();
    else if (!pendingPage) list.cancelScroll();
    const viewport = scroll.getBoundingClientRect();
    const bottom = visibleBottom(viewport);
    const distance =
      pages *
      getPageScrollDistancePx({
        containerHeightPx: viewport.height,
        scrollPaddingBottomPx: viewport.bottom - bottom,
      });
    if (mode === "VISUAL" && reader) {
      const before = reader.caret(true)?.getBoundingClientRect();
      const y = before ? before.top + before.height / 2 : viewport.top;
      reader.moveToScreenY(y + distance);
      paintText({ pageFromTop: before?.top ?? viewport.top });
    } else {
      scrollToPage(list, scroll, (pendingPage?.top ?? scroll.scrollTop) + distance);
    }
  }
  function scrollToPage(list: LegendListRef, scroll: HTMLElement, requested: number) {
    const top = Math.max(0, Math.min(requested, scroll.scrollHeight - scroll.clientHeight));
    if (top === (pendingPage?.top ?? scroll.scrollTop)) return;
    const page = { list, top };
    pendingPage = page;
    void list
      .scrollToOffset({
        offset: top,
        animated: shouldAnimateScroll(),
      })
      .then(() => {
        if (pendingPage !== page) return;
        pendingPage = null;
        if (mode === "NORMAL") selectVisibleMessage(list);
      });
  }
  function interruptPage() {
    if (!pendingPage) return;
    const { list } = pendingPage;
    pendingPage = null;
    list.cancelScroll();
    if (mode === "NORMAL") selectVisibleMessage(list);
  }
  function selectVisibleMessage(list: LegendListRef) {
    const scroll = list.getScrollableNode();
    if (!scroll) return;
    const viewport = scroll.getBoundingClientRect();
    const top = scroll.scrollTop;
    const end = top + visibleBottom(viewport) - viewport.top;
    const state = list.getState();
    const rows: readonly MessagesTimelineRow[] = state.data;
    let index = Math.max(0, state.start);
    while (index > 0 && state.positionAtIndex(index) > top) index--;
    let key: string | null = null;
    let mostVisible = 0;
    for (; index < rows.length; index++) {
      const rowTop = state.positionAtIndex(index);
      if (rowTop >= end) break;
      const row = rows[index];
      if (!row || !isSelectableMessage(row)) continue;
      const visible = Math.min(rowTop + state.sizeAtIndex(index), end) - Math.max(rowTop, top);
      if (visible > mostVisible) {
        mostVisible = visible;
        key = row.id;
      }
    }
    selectMessage(key, "viewport");
  }
  function revealText() {
    if (source?.dataset.userMessageCollapsed === "true")
      source.dispatchEvent(new Event("beforematch"));
  }

  function messageKeyDown(key: string, prefix: typeof pending) {
    const cursor = reader?.cursor;
    if (prefix === "i" || prefix === "a" || prefix === "yi" || prefix === "ya") {
      const span = cursor?.object(key, prefix.endsWith("a"));
      if (span && cursor) {
        if (prefix === "yi" || prefix === "ya") {
          void copy(cursor.contents(span));
          cursor.setPosition(span.start);
        } else cursor.select(span);
        paintText();
      }
      return true;
    }
    if (prefix === "y") {
      if (key === "i" || key === "a") pending = key === "i" ? "yi" : "ya";
      else if (cursor && (key === "y" || isVimMotion(key))) void copy(cursor.yankMotion(key));
      return true;
    }
    if (prefix === "f" || prefix === "F" || prefix === "t" || prefix === "T") {
      if (cursor?.find(prefix, key)) paintText();
      return true;
    }
    if (key === "i" || key === "a") {
      if (mode === "VISUAL") pending = key;
      else if (!readOnly) leaveNavigation();
    } else if (key === "y") {
      if (mode === "NORMAL") pending = "y";
      else if (cursor) {
        const span = cursor.selection();
        void copy(cursor.contents(span));
        cursor.setPosition(span.start);
        setMode("NORMAL");
      }
    } else if (key === "v" || key === "V") {
      if (!cursor) return true;
      if (mode === "VISUAL" && cursor.isLinewise === (key === "V")) setMode("NORMAL");
      else {
        revealText();
        cursor.startSelection(key === "V", mode === "VISUAL");
        setMode("VISUAL");
      }
    } else if (mode === "NORMAL" && prefix === "g" && key === "d") {
      focusSidebar();
    } else if (mode === "NORMAL" && (key === "g" || key === "G" || key === "J" || key === "K")) {
      if (key === "g" && prefix !== "g") pending = "g";
      else
        chooseMessage(
          key === "g" ? "first" : key === "G" ? "last" : key === "J" ? "next" : "previous",
        );
    } else if (key === "f" || key === "F" || key === "t" || key === "T") pending = key;
    else if (isVimMotion(key)) {
      revealText();
      if (cursor?.move(key)) paintText({ smooth: key === "j" || key === "k" });
      else if (mode === "NORMAL" && (key === "j" || key === "k" || key === "{" || key === "}")) {
        chooseMessage(key === "j" || key === "}" ? "next" : "previous");
      }
    } else return false;
    return true;
  }
  function normalKey(event: KeyboardEvent, target: HTMLElement) {
    const { key } = event;
    if (key === "Shift" || key === "Control" || key === "Alt" || key === "Meta") return false;
    if (key === "Escape" && mode === "VISUAL") {
      setMode("NORMAL");
      return true;
    }
    interruptPage();
    const inMessage = reading(target);
    if (inMessage && !isCurrentSource(source)) markMessage();
    const prefix = pending;
    pending = "";
    if (key === "Escape") {
      if (!inMessage) enterNormal();
      else if (readOnly) leaveNavigation();
    } else if (inMessage && key === "Tab") {
      setMode("NORMAL");
      if (isCurrentSource(source)) source.focus({ preventScroll: true });
      return false;
    } else if (inMessage && prefix && prefix !== "g") {
      return messageKeyDown(key, prefix);
    } else if (key === "[" || key === "]") {
      setMode("NORMAL");
      if (inMessage) {
        column.querySelector<HTMLElement>('[data-workspace-area="conversation"]')?.focus({
          preventScroll: true,
        });
      }
      moveWorkspaceFocus(key === "]" ? 1 : -1);
    } else if (!inMessage) {
      if ((key === "i" || key === "a") && !readOnly) leaveNavigation();
      else if (key === "j" || key === "k")
        focusAdjacentWorkspaceControl(target, key === "j" ? 1 : -1);
      else return false;
    } else return messageKeyDown(key, prefix);
    return true;
  }
  function available(event: KeyboardEvent) {
    const target = event.target;
    return (
      target instanceof HTMLElement &&
      !event.defaultPrevented &&
      !event.isComposing &&
      event.keyCode !== 229 &&
      !event.metaKey &&
      !event.altKey &&
      !target.closest(PROTECTED) &&
      !doc.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR)
    );
  }
  enterVimNormalModeRef.current = (event) => {
    if (event.ctrlKey || event.shiftKey || !available(event)) return false;
    enterNormal();
    return true;
  };
  function onKey(event: KeyboardEvent) {
    const target = event.target;
    if (mode === "INSERT" || !(target instanceof HTMLElement) || isEditableFocused(target)) return;
    if (
      target !== doc.body &&
      !belongsToChat(target) &&
      (!target.closest("[data-workspace-area]") || target.closest("[data-chat-column]"))
    )
      return;
    if (event.ctrlKey || !available(event) || !normalKey(event, target)) return;
    event.preventDefault();
    event.stopPropagation();
  }
  const onFocus = (event: FocusEvent) => {
    if (mode === "INSERT" || !(event.target instanceof HTMLElement)) return;
    const target = event.target;
    if (target !== button) {
      interruptPage();
      cancelMessageScroll();
    }
    if (
      target.closest("[data-composer-rich-text]") ||
      (target.closest("[data-chat-column]") && !belongsToChat(target))
    )
      setMode("INSERT");
    else if (target !== button && target.closest("[data-workspace-area]")) {
      if (mode === "VISUAL") setMode("NORMAL");
      const message = target.closest<HTMLElement>(SOURCE);
      const key = message?.closest<HTMLElement>("[data-timeline-row-id]")?.dataset.timelineRowId;
      if (message && key && key !== messageKey && belongsToChat(message)) {
        selectMessage(key);
      }
    }
  };
  const removePaging = registerCommands(
    {},
    {
      capture: true,
      when: (event) =>
        mode !== "INSERT" &&
        (!pending || event.ctrlKey || event.key === "PageUp" || event.key === "PageDown") &&
        pageStep(event, mode) !== 0 &&
        reading(event.target) &&
        available(event),
      onKeyDown: (event) => {
        scrollPage(pageStep(event, mode));
        event.preventDefault();
        event.stopPropagation();
      },
    },
  );
  const removeSidebarReturn = registerCommands(
    {},
    {
      capture: true,
      when: (event) =>
        mode === "NORMAL" &&
        (event.key === "Escape" || event.key === "i") &&
        !(
          event.ctrlKey ||
          event.altKey ||
          event.metaKey ||
          event.shiftKey ||
          event.isComposing ||
          event.keyCode === 229
        ) &&
        event.target instanceof HTMLElement &&
        event.target.matches(
          '[data-app-sidebar] :is([data-sidebar-row], [data-sidebar="menu-button"])',
        ),
      onKeyDown: (event) => {
        event.preventDefault();
        event.stopPropagation();
        const selection = useThreadSelectionStore.getState();
        if (event.key === "Escape" && selection.hasSelection()) {
          selection.clearSelection();
          return;
        }
        leaveSidebar(() => {
          if (!button.isConnected) return;
          if (event.key === "Escape" || readOnly) button.focus({ preventScroll: true });
          else leaveNavigation();
        });
      },
    },
  );
  button.addEventListener("click", toggle);
  column.addEventListener("wheel", interruptHistoryScroll, { passive: true });
  column.addEventListener("pointerdown", interruptHistoryScroll, { passive: true });
  doc.addEventListener("keydown", onKey);
  doc.addEventListener("focusin", onFocus);
  return () => {
    removePaging();
    removeSidebarReturn();
    if (pendingPage) pendingPage.list.cancelScroll();
    pendingPage = null;
    cancelMessageScroll();
    rowsObserver.disconnect();
    enterVimNormalModeRef.current = null;
    closeReader();
    source?.removeAttribute("data-vim-message");
    column.removeAttribute("data-vim-navigation");
    doc.removeEventListener("keydown", onKey);
    doc.removeEventListener("focusin", onFocus);
    column.removeEventListener("wheel", interruptHistoryScroll);
    column.removeEventListener("pointerdown", interruptHistoryScroll);
    button.removeEventListener("click", toggle);
  };
}
