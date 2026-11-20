import { RegistryContext } from "@effect/atom-react";
import { X } from "lucide-react";
import { useCallback, useContext, useSyncExternalStore } from "react";

import { dismissUpdateToast, type UpdateToast } from "../state/updatesAtoms";

const TOAST_MS = 10_000;
const TONE = {
  info: "text-sky-300",
  success: "text-emerald-300",
  error: "text-amber-300",
} as const;

export function UpdateToastCard({ toast, onOpen }: { toast: UpdateToast; onOpen: () => void }) {
  const registry = useContext(RegistryContext);
  const dismiss = useCallback(() => dismissUpdateToast(registry, toast.id), [registry, toast.id]);
  useSyncExternalStore(
    useCallback(() => {
      const timer = setTimeout(dismiss, TOAST_MS);
      return () => clearTimeout(timer);
    }, [dismiss]),
    () => null,
  );
  const body = (
    <>
      <span className={`block font-semibold ${TONE[toast.tone]}`}>{toast.title}</span>
      {toast.description !== null && (
        <span className="block break-words whitespace-pre-line text-muted">
          {toast.description}
        </span>
      )}
    </>
  );
  return (
    <div
      data-testid="update-toast"
      className="flex items-start gap-1 rounded-lg border border-line bg-panel text-xs shadow-panel"
    >
      {toast.opensUpdates ? (
        <button
          type="button"
          aria-label={`Open updates: ${toast.title}`}
          onClick={() => {
            onOpen();
            dismiss();
          }}
          className="min-w-0 flex-1 rounded-lg px-3 py-2 text-left hover:bg-hover"
        >
          {body}
        </button>
      ) : (
        <div className="min-w-0 flex-1 px-3 py-2">{body}</div>
      )}
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
