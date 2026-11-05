import { getClientSettings, subscribeClientSettings } from "./hooks/useSettings";
import type { createTextareaVimHost } from "./textarea-vim";
import { handleVimNavigationKey } from "./vim-navigation";

type TextareaHost = ReturnType<typeof createTextareaVimHost>;

// The terminal and browser panel use hidden textareas as keyboard sinks for their own input.
const TEXTAREA_SELECTOR = "textarea:not([data-vim-ignore], [readonly], [disabled])";

/** Vim keys for every textarea and for moving around the app; the composer attaches itself. */
export function startVimMode() {
  const hosts = new Map<HTMLTextAreaElement, TextareaHost>();
  let enabled = false;

  const attach = (textarea: HTMLTextAreaElement) => {
    if (hosts.has(textarea)) return;
    void import("./textarea-vim").then(({ createTextareaVimHost }) => {
      if (enabled && textarea.isConnected && !hosts.has(textarea)) {
        hosts.set(textarea, createTextareaVimHost(textarea));
      }
    });
  };
  const onFocusIn = (event: FocusEvent) => {
    for (const [textarea, host] of hosts) {
      if (textarea.isConnected) continue;
      host.destroy();
      hosts.delete(textarea);
    }
    const { target } = event;
    if (target instanceof HTMLTextAreaElement && target.matches(TEXTAREA_SELECTOR)) attach(target);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const host = event.target instanceof HTMLTextAreaElement ? hosts.get(event.target) : undefined;
    if (!(host ? host.handleKeyDown(event) : handleVimNavigationKey(event))) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const apply = () => {
    const next = getClientSettings().vimModeEnabled;
    if (next === enabled) return;
    enabled = next;
    if (enabled) {
      window.addEventListener("focusin", onFocusIn, true);
      window.addEventListener("keydown", onKeyDown, true);
      if (document.activeElement instanceof HTMLTextAreaElement) {
        if (document.activeElement.matches(TEXTAREA_SELECTOR)) attach(document.activeElement);
      }
      return;
    }
    window.removeEventListener("focusin", onFocusIn, true);
    window.removeEventListener("keydown", onKeyDown, true);
    for (const host of hosts.values()) host.destroy();
    hosts.clear();
  };
  apply();
  return subscribeClientSettings(apply);
}
