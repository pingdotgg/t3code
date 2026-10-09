import type { LegendListRef } from "@legendapp/list/react";
import {
  htmlSelectionClientRect,
  htmlSelectionCommand,
  htmlSelectionParams,
  readHtmlSelectionRect,
} from "~/lib/htmlRenderSelection";
import type { AssistantCitationTarget } from "./AssistantCitationSource";
import { toastManager } from "../ui/toast";

/** Resolves and marks the quote inside its opaque frame before scrolling the timeline. */
export function observeHtmlRenderCitationSource({
  root,
  itemKey,
  request,
  list,
}: {
  root: HTMLElement;
  itemKey: string;
  request: AssistantCitationTarget;
  list: LegendListRef;
}) {
  const activation = request.activationRef.current;
  if (activation.dismissed) return;
  const scrollNode = list.getScrollableNode();
  if (!(scrollNode instanceof HTMLElement)) return;
  let stopped = false;
  let frame: HTMLIFrameElement | null = null;
  let scrolling = false;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let responseTimeout: ReturnType<typeof setTimeout> | undefined;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const resolve = () => {
    if (stopped || activation.dismissed || !root.isConnected || scrolling) return;
    if (root.querySelector("[data-html-render-error]")) {
      activation.dismissed = true;
      request.onComplete();
      toastManager.add({
        type: "warning",
        title: "Could not load the cited HTML",
        description: "Reconnect to the environment and try again. The saved quote is unchanged.",
      });
      return;
    }
    frame = root.querySelector<HTMLIFrameElement>("iframe[data-html-selection-ready]");
    if (frame) {
      responseTimeout ??= setTimeout(() => {
        if (stopped || activation.dismissed) return;
        activation.dismissed = true;
        if (frame) htmlSelectionCommand(frame, "unmark");
        request.onComplete();
        toastManager.add({
          type: "warning",
          title: "Could not open the cited HTML",
          description:
            "Update or reconnect to the environment and try again. The saved quote is unchanged.",
        });
      }, 5000);
      htmlSelectionCommand(frame, "target", request.citation);
    }
  };
  const receive = (event: MessageEvent) => {
    if (stopped || activation.dismissed || !frame || event.source !== frame.contentWindow) return;
    const params = htmlSelectionParams(event.data);
    if (!params || !("target" in params)) return;
    const selector = params.selector as Partial<typeof request.citation> | undefined;
    if (
      !selector ||
      selector.text !== request.citation.text ||
      selector.start !== request.citation.start ||
      selector.end !== request.citation.end ||
      selector.prefix !== request.citation.prefix ||
      selector.suffix !== request.citation.suffix
    )
      return;
    const local = readHtmlSelectionRect(params.target);
    clearTimeout(responseTimeout);
    responseTimeout = undefined;
    const rect = local ? htmlSelectionClientRect(frame, local) : root.getBoundingClientRect();
    const state = list.getState();
    const index = state.indexByKey(itemKey);
    if (index === undefined || !(state.sizeAtIndex(index) > 0) || scrollNode.clientHeight <= 0)
      return;
    if (!activation.scrolled) {
      if (scrolling) return;
      const offset = Math.max(
        0,
        Math.min(
          scrollNode.scrollHeight - scrollNode.clientHeight,
          state.scroll +
            rect.top -
            scrollNode.getBoundingClientRect().top -
            Math.min(120, scrollNode.clientHeight / 3),
        ),
      );
      if (Math.abs(offset - state.scroll) > 1) {
        scrolling = true;
        void list.scrollToOffset({ offset, animated: !reducedMotion }).then(
          () => {
            scrolling = false;
            resolve();
          },
          () => {
            scrolling = false;
            if (stopped || activation.dismissed) return;
            activation.dismissed = true;
            request.onComplete();
            toastManager.add({
              type: "warning",
              title: "Could not open the cited response",
              description: "Click the citation to try again.",
            });
          },
        );
        return;
      }
      activation.scrolled = true;
      request.onComplete();
      if (!local)
        toastManager.add({
          type: "warning",
          title: "The quoted text has changed",
          description: "Showing the source response. The saved quote is unchanged.",
        });
    }
    if (expiry === undefined) {
      const pulse = (activation.pulse ??= { startedAt: performance.now(), reducedMotion });
      expiry = setTimeout(
        () => {
          activation.dismissed = true;
          if (frame) htmlSelectionCommand(frame, "unmark");
        },
        Math.max(0, 3000 - (performance.now() - pulse.startedAt)),
      );
    }
  };
  const observer = new MutationObserver(resolve);
  observer.observe(root, { childList: true, subtree: true });
  const resize = new ResizeObserver(resolve);
  resize.observe(root);
  const stopPosition = list.getState().listenToPosition(itemKey, resolve);
  const cancelScroll = () => {
    if (scrolling) {
      scrolling = false;
      void list.scrollToOffset({
        get offset() {
          return scrollNode.scrollTop;
        },
        animated: false,
      });
    }
  };
  activation.cancelScroll = cancelScroll;
  root.addEventListener("t3-html-selection-ready", resolve);
  window.addEventListener("message", receive);
  resolve();
  return () => {
    stopped = true;
    cancelScroll();
    clearTimeout(expiry);
    clearTimeout(responseTimeout);
    observer.disconnect();
    resize.disconnect();
    stopPosition();
    root.removeEventListener("t3-html-selection-ready", resolve);
    window.removeEventListener("message", receive);
    if (activation.cancelScroll === cancelScroll) delete activation.cancelScroll;
    if (frame) htmlSelectionCommand(frame, "unmark");
  };
}
