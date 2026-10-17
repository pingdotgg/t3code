import { createContext, useContext, useEffect, useLayoutEffect, useState } from "react";

// Activity hides its DOM but not body portals; kept subtrees need a container that hides with them.
export const PortalContainerContext = createContext<HTMLElement | undefined>(undefined);

export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainerContext);
}

/** Kept views remove the container on release; other callers must sit outside their Activity. */
export function useOwnPortalContainer(
  hidden: boolean,
  lifetime: { hold(release: () => void): unknown } | null,
): HTMLElement {
  const [container] = useState(() => {
    const element = document.createElement("div");
    element.hidden = true;
    return element;
  });
  useLayoutEffect(() => {
    if (!container.isConnected) {
      document.body.append(container);
      lifetime?.hold(() => container.remove());
    }
    container.toggleAttribute("hidden", hidden);
    // Activity runs cleanup on hide without releasing the view.
    return () => {
      container.toggleAttribute("hidden", true);
    };
  }, [container, hidden, lifetime]);
  useEffect(() => {
    if (lifetime !== null) return;
    return () => container.remove();
  }, [container, lifetime]);
  return container;
}
