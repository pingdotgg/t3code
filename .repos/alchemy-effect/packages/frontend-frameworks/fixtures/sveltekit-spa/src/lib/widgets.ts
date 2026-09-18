/**
 * Imported by the widgets page as `$spa/widgets` — the alias is declared in
 * the user's `vite.config.ts` (`sveltekit({ alias: { $spa: "src/lib" } })`),
 * so the route only resolves when that config file is honored.
 */
export interface Widget {
  readonly id: string;
  readonly name: string;
}

export const describeWidgets = (widgets: ReadonlyArray<Widget>): string =>
  `widgets-via-user-alias:${widgets.length}`;
