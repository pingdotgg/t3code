import { useEffect } from "react";

import { useReactGrabEnabled } from "~/hooks/useSettings";
import { setReactGrabEnabled } from "~/lib/reactGrab";

/**
 * Bridges the `reactGrabEnabled` setting to the React Grab overlay loaded in
 * `main.tsx`. Renders nothing; lives at the app root so the overlay follows the
 * setting from anywhere in the app. Outside dev builds both the hook and
 * `setReactGrabEnabled` are inert.
 */
export function ReactGrabController(): null {
  const enabled = useReactGrabEnabled();
  useEffect(() => {
    setReactGrabEnabled(enabled);
  }, [enabled]);
  return null;
}
