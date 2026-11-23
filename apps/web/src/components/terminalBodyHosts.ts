import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

/** Where one thread's drawer terminals render; the drawer moves it into its body while shown. */
export interface TerminalBodyHost {
  readonly threadRef: ScopedThreadRef | null;
  readonly element: HTMLDivElement;
  /** Moves the element into a drawer body, keeping the focus a same-commit park took away. */
  readonly place: (slot: HTMLElement) => void;
  /** Takes the element back out of the drawer, into the hidden holder. */
  readonly park: () => void;
}

/**
 * One stable element per thread, so a thread's terminals survive the drawer remounting (a
 * thread switch, a closed panel, the sheet layout) without re-attaching.
 */
export function createTerminalBodyHosts() {
  const hosts = new Map<string, TerminalBodyHost>();
  let holder: HTMLElement | null = null;
  return {
    host(threadKey: string): TerminalBodyHost {
      let host = hosts.get(threadKey);
      if (!host) {
        const element = document.createElement("div");
        element.className = "flex min-h-0 flex-1 flex-col";
        // A drawer remount parks and re-places the element in one commit, and moving a node
        // blurs what it contains. Only that hand-off restores focus, never a later reopen.
        let parkedFocus: HTMLElement | null = null;
        host = {
          threadRef: parseScopedThreadKey(threadKey),
          element,
          place: (slot) => {
            const focus = parkedFocus;
            parkedFocus = null;
            slot.appendChild(element);
            if (focus && element.contains(focus) && document.activeElement !== focus) {
              focus.focus({ preventScroll: true });
            }
          },
          park: () => {
            const active = document.activeElement;
            if (active instanceof HTMLElement && element.contains(active)) {
              parkedFocus = active;
              queueMicrotask(() => {
                if (parkedFocus === active) parkedFocus = null;
              });
            }
            if (holder) holder.appendChild(element);
            else element.remove();
          },
        };
        hosts.set(threadKey, host);
      }
      return host;
    },
    setHolder(element: HTMLElement | null) {
      holder = element;
    },
    retain(threadKeys: ReadonlySet<string>) {
      for (const [threadKey, host] of hosts) {
        if (threadKeys.has(threadKey)) continue;
        host.element.remove();
        hosts.delete(threadKey);
      }
    },
  };
}

export type TerminalBodyHosts = ReturnType<typeof createTerminalBodyHosts>;
