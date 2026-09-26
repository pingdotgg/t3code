import { useState } from "react";

/** Clear portaled menus when their measured, still-mounted triggers hide. */
export function useComposerMenuState(hidden = false) {
  const [open, setOpen] = useState(false);
  // Base UI does not notify us when we close it by changing its open prop.
  // Reset the stored state too, so revealing the trigger cannot reopen it.
  if (hidden && open) {
    setOpen(false);
  }
  return [open && !hidden, setOpen] as const;
}
