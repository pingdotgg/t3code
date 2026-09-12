import { createContext, useContext } from "react";

export const ThreadListPreviewContext = createContext<{
  showing: boolean;
  setShowing: (showing: boolean) => void;
} | null>(null);

export function useThreadListPreview() {
  const context = useContext(ThreadListPreviewContext);
  if (!context) throw new Error("Thread list preview requires AppSidebarLayout");
  return context;
}
