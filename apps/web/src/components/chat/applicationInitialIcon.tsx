import type { Icon } from "../Icons";

/**
 * Components are cached per initial so the whole "Open with" list reuses at
 * most a couple of dozen instances, and React keeps element identity stable
 * across re-renders instead of remounting every row.
 */
const cache = new Map<string, Icon>();

function initialOf(name: string): string {
  // Match on a letter or digit so a leading bracket or dot does not become the
  // avatar; fall back to a neutral glyph when the name has neither.
  const match = /[\p{L}\p{N}]/u.exec(name);
  return (match?.[0] ?? "?").toUpperCase();
}

/**
 * A lettered badge standing in for an application's own icon.
 *
 * Real icons would mean resolving each platform's icon theme and shipping the
 * bitmaps over the websocket, which is a lot of bytes for a menu; the initial
 * is enough to tell one row from the next.
 */
export function applicationInitialIcon(name: string): Icon {
  const initial = initialOf(name);
  const cached = cache.get(initial);
  if (cached !== undefined) return cached;

  const Component: Icon = (props) => (
    <svg fill="none" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" {...props}>
      <rect
        height="15"
        rx="4"
        stroke="currentColor"
        strokeOpacity="0.4"
        width="15"
        x="0.5"
        y="0.5"
      />
      <text fill="currentColor" fontSize="8.5" fontWeight="500" textAnchor="middle" x="8" y="11.25">
        {initial}
      </text>
    </svg>
  );
  Component.displayName = `ApplicationInitialIcon(${initial})`;
  cache.set(initial, Component);
  return Component;
}
