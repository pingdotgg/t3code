import { useEffect } from "react";

import { useTheme } from "../../hooks/useTheme";
import { syncOmarchyLinkedTheme } from "../../omarchyLinkedTheme";

export function OmarchyLinkedThemeSync() {
  const { refreshTheme } = useTheme();

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.getOmarchyTheme || !bridge.onOmarchyThemeChange) return;

    let active = true;
    let changeVersion = 0;
    const apply = (theme: Awaited<ReturnType<typeof bridge.getOmarchyTheme>>) => {
      if (!active) return;
      const result = syncOmarchyLinkedTheme(theme);
      if (result.status === "preserved") {
        console.warn("Could not update the Omarchy linked theme; keeping the last valid palette.", {
          error: result.error,
        });
      }
      refreshTheme();
    };

    const unsubscribe = bridge.onOmarchyThemeChange((theme) => {
      changeVersion += 1;
      apply(theme);
    });
    const requestedAtVersion = changeVersion;
    void bridge
      .getOmarchyTheme()
      .then((theme) => {
        if (changeVersion === requestedAtVersion) apply(theme);
      })
      .catch((error: unknown) => {
        console.warn("Could not read the Omarchy linked theme.", { error });
      });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [refreshTheme]);

  return null;
}
