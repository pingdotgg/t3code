import { RegistryContext } from "@effect/atom-react";
import { X } from "lucide-react";
import { useCallback, useContext, useSyncExternalStore } from "react";

import type { ForYouToast } from "../domain/forYou";
import { forYouToastsAtom } from "../state/forYou";
import { showForYouCard } from "./ForYouRow";

const TOAST_MS = 8_000;

/** One toast. It opens its card on a press, and goes away on its own after a few seconds. */
export function ForYouToastCard({ toast }: { toast: ForYouToast }) {
  const registry = useContext(RegistryContext);
  const dismiss = useCallback(() => {
    const state = registry.get(forYouToastsAtom);
    registry.set(forYouToastsAtom, {
      ...state,
      toasts: state.toasts.filter((entry) => entry.id !== toast.id),
    });
  }, [registry, toast.id]);
  useSyncExternalStore(
    useCallback(() => {
      const timer = setTimeout(dismiss, TOAST_MS);
      return () => clearTimeout(timer);
    }, [dismiss]),
    () => null,
  );
  return (
    <div
      data-testid="foryou-toast"
      data-card-id={toast.cardId}
      className="flex items-start gap-1 rounded-lg border border-line bg-panel shadow-panel"
    >
      <button
        type="button"
        aria-label={`Open ${toast.title}`}
        onClick={() => {
          showForYouCard(registry, toast, toast.cardId);
          dismiss();
        }}
        className="min-w-0 flex-1 rounded-lg px-3 py-2 text-left hover:bg-hover"
      >
        <span className="block text-[11px] text-amber-300">For you on {toast.boardName}</span>
        <span className="block truncate font-semibold text-fg">{toast.title}</span>
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismiss}
        className="m-1.5 grid size-5 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
