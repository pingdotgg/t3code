import { trackPageArea } from "./pageBounds";

/** Where the active tab's native page sits. */
export function PageArea() {
  return (
    <div ref={trackPageArea} data-testid="browser-page" className="relative min-h-0 flex-1 bg-bg" />
  );
}
