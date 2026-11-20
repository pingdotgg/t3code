import { useAtomValue } from "@effect/atom-react";

import { forYouToastsAtom } from "../state/forYou";
import { ForYouToastCard } from "./ForYouToastCard";

/** The corner where For-you toasts stack. */
export function ForYouToasts() {
  const { toasts } = useAtomValue(forYouToastsAtom);
  return (
    <div
      role="status"
      aria-label="For you notifications"
      className="fixed top-12 right-4 z-50 flex w-72 flex-col gap-2"
    >
      {toasts.map((toast) => (
        <ForYouToastCard key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
