/**
 * Imported by the widgets page as `#lib/widgets.js` — a `package.json`
 * subpath import (kit v3's replacement for `$lib`), resolved in the
 * client-side load.
 */
export interface Widget {
  readonly id: string;
  readonly name: string;
}

export const describeWidgets = (widgets: ReadonlyArray<Widget>): string =>
  `widgets-via-subpath-import:${widgets.length}`;
