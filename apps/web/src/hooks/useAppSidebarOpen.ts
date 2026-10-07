import { useCallback, useState } from "react";

export function useAppSidebarOpen(isOnSettings: boolean) {
  const [state, setState] = useState({
    isOnSettings,
    threadOpen: true,
    settingsOpen: true,
  });

  // Reveal categories before paint on entry, without changing the thread preference.
  // Section navigation stays within the same Settings visit and keeps manual toggles.
  if (state.isOnSettings !== isOnSettings) {
    setState({ ...state, isOnSettings, settingsOpen: true });
  }

  const onOpenChange = useCallback(
    (open: boolean) => {
      setState((current) => ({
        ...current,
        ...(isOnSettings ? { settingsOpen: open } : { threadOpen: open }),
      }));
    },
    [isOnSettings],
  );

  return {
    open: isOnSettings ? state.settingsOpen : state.threadOpen,
    onOpenChange,
  };
}
