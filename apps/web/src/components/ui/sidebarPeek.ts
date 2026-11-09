import { useEffect, useState, useSyncExternalStore } from "react";
import { subscribeContextMenu } from "~/localApi";

function createSidebarPeek() {
  let snapshot = { revealed: false, hasRevealed: false };
  let inside = false;
  let keyboard = false;
  let portalFocused = false;
  let contextMenuOpen = false;
  let connected = false;
  let sidebar: HTMLDivElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const clear = () => clearTimeout(timer);
  const publish = (value: boolean, reset = false) => {
    clear();
    const hasRevealed = !reset && (value || snapshot.hasRevealed);
    if (snapshot.revealed === value && snapshot.hasRevealed === hasRevealed) return;
    if (
      !value &&
      sidebar?.dataset.state === "collapsed" &&
      sidebar.contains(document.activeElement)
    ) {
      const wrapper = sidebar.closest('[data-slot="sidebar-wrapper"]');
      const trigger = Array.from(
        wrapper?.querySelectorAll<HTMLElement>('[data-sidebar="trigger"]') ?? [],
      ).find((element) => !sidebar?.contains(element));
      trigger?.focus({ preventScroll: true });
    }
    snapshot = { revealed: value, hasRevealed };
    for (const listener of listeners) listener();
  };
  const hide = () => {
    clear();
    if (!connected) return;
    timer = setTimeout(() => {
      const popupOpen = sidebar?.querySelector('[aria-haspopup][aria-expanded="true"]');
      if (
        !inside &&
        !portalFocused &&
        !contextMenuOpen &&
        !popupOpen &&
        !sidebar?.querySelector(":active")
      ) {
        if (!keyboard || !sidebar?.contains(document.activeElement)) publish(false);
      }
    }, 200);
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    ref(node: HTMLDivElement | null) {
      sidebar = node;
      return () => {
        sidebar = null;
      };
    },
    connect() {
      connected = true;
      // Popup triggers stay in the sidebar even when their content is portaled.
      const observer = new MutationObserver(() => {
        if (!inside) hide();
      });
      if (sidebar)
        observer.observe(sidebar, {
          subtree: true,
          attributes: true,
          attributeFilter: ["aria-expanded"],
        });
      const unsubscribeContextMenu = subscribeContextMenu((position) => {
        const rect = sidebar
          ?.querySelector('[data-slot="sidebar-container"]')
          ?.getBoundingClientRect();
        contextMenuOpen =
          snapshot.revealed &&
          position !== null &&
          rect !== undefined &&
          position.x >= rect.left &&
          position.x <= rect.right &&
          position.y >= rect.top &&
          position.y <= rect.bottom;
        if (!contextMenuOpen && !inside) hide();
      });
      const onKeyDown = (event: KeyboardEvent) => {
        keyboard = true;
        if (event.key === "Escape" && !event.defaultPrevented) publish(false);
      };
      const onPointerDown = () => {
        keyboard = false;
      };
      const onBlur = () => {
        if (!contextMenuOpen) publish(false);
      };
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("pointerdown", onPointerDown);
      window.addEventListener("blur", onBlur);
      return () => {
        connected = false;
        observer.disconnect();
        unsubscribeContextMenu();
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("pointerdown", onPointerDown);
        window.removeEventListener("blur", onBlur);
        inside = false;
        portalFocused = false;
        contextMenuOpen = false;
        publish(false, true);
      };
    },
    edgeEnter(event: React.PointerEvent) {
      if (event.pointerType !== "mouse" || event.buttons !== 0) return;
      clear();
      timer = setTimeout(() => publish(true), 110);
    },
    edgeLeave: hide,
    enter(event: React.PointerEvent) {
      if (event.pointerType !== "mouse") return;
      inside = true;
      clear();
    },
    leave(event: React.PointerEvent) {
      if (event.pointerType !== "mouse") return;
      inside = false;
      hide();
    },
    focus(event: React.FocusEvent) {
      portalFocused = !sidebar?.contains(event.target);
      clear();
      if (!inside) hide();
    },
    blur() {
      portalFocused = false;
      if (!inside) hide();
    },
    release() {
      if (!inside) hide();
    },
  };
}

export function useSidebarPeek(enabled: boolean) {
  const [peek] = useState(createSidebarPeek);
  const snapshot = useSyncExternalStore(peek.subscribe, peek.getSnapshot, peek.getSnapshot);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- connects pointer/focus dismissal to the window while edge reveal is available
  useEffect(() => (enabled ? peek.connect() : undefined), [enabled, peek]);
  return {
    ...peek,
    revealed: enabled && snapshot.revealed,
    hasRevealed: enabled && snapshot.hasRevealed,
  };
}
