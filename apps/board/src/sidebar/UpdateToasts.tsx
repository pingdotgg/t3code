import { useAtomValue } from "@effect/atom-react";

import { updateToastsAtom } from "../state/updatesAtoms";
import { UpdateToastCard } from "./UpdateToastCard";

/** The corner where engine and provider update toasts stack, above the usage bar. */
export function UpdateToasts({ onOpen }: { onOpen: () => void }) {
  const toasts = useAtomValue(updateToastsAtom);
  return (
    <div
      role="status"
      aria-label="Update notifications"
      className="fixed right-4 bottom-10 z-50 flex w-80 flex-col gap-2"
    >
      {toasts.map((toast) => (
        <UpdateToastCard key={toast.id} toast={toast} onOpen={onOpen} />
      ))}
    </div>
  );
}
