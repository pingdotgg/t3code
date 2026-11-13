import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

export type ThreadTagPickerAnchor = Element | { readonly x: number; readonly y: number };

export interface ThreadTagPickerTarget {
  readonly threadRef: ScopedThreadRef;
  readonly anchor: ThreadTagPickerAnchor | null;
}

/** Which thread has the tag picker open. Menus and the palette close as they run, so the root renders it once. */
export const threadTagPickerAtom = Atom.make<ThreadTagPickerTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("thread-tags:picker"),
);

/** Anchors to the given element or menu point, else the thread's sidebar row, else the header chips or title. */
export function openThreadTagPicker(
  threadRef: ScopedThreadRef,
  anchor?: ThreadTagPickerAnchor | null,
): void {
  const found =
    anchor ??
    [
      document.querySelector(`[data-thread-item="${CSS.escape(scopedThreadKey(threadRef))}"]`),
      document.querySelector("[data-thread-tag-chips]"),
      document.querySelector("[data-thread-tag-title]"),
    ].find(isShown) ??
    null;
  appAtomRegistry.set(threadTagPickerAtom, { threadRef, anchor: found });
}

// A collapsed sidebar keeps its rows mounted but inert and off-screen.
function isShown(element: Element | null): element is Element {
  if (element === null || element.closest("[inert]") !== null) return false;
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}
