import { useState } from "react";

export function useComposerMenuState(hidden = false) {
  const [open, setOpen] = useState(false);
  // Closing via the open prop does not notify Base UI listeners; reset stored state too.
  if (hidden && open) {
    setOpen(false);
  }
  return [open && !hidden, setOpen] as const;
}
