import { useRef, useState } from "react";
import { Input } from "../ui/input";

/** Mount a fresh draft each time rename starts, keyed by the selected look. */
export function LookNameInput({
  look,
  onRename,
  onDone,
}: {
  look: { name: string };
  onRename: (name: string) => void;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(look.name);
  const cancelled = useRef(false);
  const commit = () => {
    const name = draft.trim();
    if (!cancelled.current && name && name !== look.name) onRename(name);
    cancelled.current = false;
    onDone();
  };
  return (
    <Input
      size="sm"
      aria-label="Look name"
      className="min-w-0 flex-1"
      autoFocus
      value={draft}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          event.stopPropagation();
          cancelled.current = true;
          event.currentTarget.blur();
        }
      }}
    />
  );
}
