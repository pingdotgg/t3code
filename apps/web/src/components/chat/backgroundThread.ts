import { createContext, use, useState } from "react";

/**
 * True for a thread kept mounted under Settings or Usage, or shown as a side chat in its
 * parent's panel; its global shortcuts and listeners stand down.
 */
export const BackgroundThreadContext = createContext(false);

export const ThreadCoveredByModalContext = createContext(false);

export function useComposerModelPickerOpen() {
  const covered = use(ThreadCoveredByModalContext);
  const [open, setOpen] = useState(false);
  if (covered && open) setOpen(false);
  return [open, setOpen] as const;
}
