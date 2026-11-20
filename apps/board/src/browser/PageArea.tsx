import { trackPageArea } from "./pageBounds";

/** Where the active tab's native page sits. With no tab open it says how to open one. */
export function PageArea({ empty }: { empty: boolean }) {
  return (
    <div ref={trackPageArea} data-testid="browser-page" className="relative min-h-0 flex-1 bg-bg">
      {empty && (
        <p className="grid h-full place-items-center px-6 text-center text-muted">
          Type a URL above, or open a link from a card.
        </p>
      )}
    </div>
  );
}
