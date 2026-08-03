/**
 * fork: f4 focus model — regions whose printable keys are not the composer's.
 *
 * The defect this exists for: `ChatView`'s type-to-focus runs in a **window
 * capture-phase** `keydown` listener, inserts the character into the chat
 * composer and then calls `preventDefault()` + `stopPropagation()`. Its own
 * guard only bails when the event path contains an editable element or a *leaf*
 * interactive role (`button`, `option`, `menuitem`, …).
 *
 * A composite widget breaks that assumption. An `aria-activedescendant`
 * listbox — the source-control changes list and history list both are one —
 * keeps DOM focus on the CONTAINER and only points at the active row, so the
 * row's `role="option"` is never an ancestor of the event target and never
 * appears in `composedPath()`. Every bare letter the list owns (`j k s u x`)
 * was therefore swallowed, typed into the composer, and the composer stole
 * focus on the way out — so the panel's documented keys did nothing, and the
 * panel's own `stopPropagation` (bubble phase) could never run.
 *
 * The rule is "focus is already inside a region that owns its keys", so it is
 * expressed as roles rather than as one more competing capture listener.
 */

/**
 * Roles that own their keyboard while focused. Leaf roles (`option`, `button`,
 * `tab`, …) are deliberately absent: upstream's own guard already covers those,
 * and they are only ever the event target when they hold real DOM focus.
 */
export const COMPOSER_KEY_OWNING_ROLES: ReadonlyArray<string> = [
  // `aria-activedescendant` composites: focus stays on the container.
  "listbox",
  "grid",
  "treegrid",
  "tree",
  "menu",
  "menubar",
  "toolbar",
  // Modal surfaces: typing belongs to whatever is inside them, never to a
  // composer rendered behind them.
  "dialog",
  "alertdialog",
];

const COMPOSER_KEY_OWNING_ROLE_SET: ReadonlySet<string> = new Set(COMPOSER_KEY_OWNING_ROLES);

/**
 * Opt-in marker for a region whose keys are its own but whose role is not one
 * of the above — the source-control panel body owns `/` from anywhere inside
 * it, and that is a plain `<div>`.
 */
export const COMPOSER_KEY_OWNING_ATTRIBUTE = "data-keys-owned";

/**
 * Selector form, for `Element.closest()` against the event's composed path.
 */
export const COMPOSER_KEY_OWNING_SELECTOR: string = [
  ...COMPOSER_KEY_OWNING_ROLES.map((role) => `[role="${role}"]`),
  `[${COMPOSER_KEY_OWNING_ATTRIBUTE}]`,
].join(",");

/**
 * Pure mirror of the DOM check, for tests: does this composed path (event
 * target first, then ancestors) sit inside a region that owns its keys?
 *
 * Equivalent to `path.some((el) => el.closest(COMPOSER_KEY_OWNING_SELECTOR))`,
 * because every ancestor `closest()` could reach is itself in the path.
 */
export function pathOwnsPrintableKeys(
  pathRoles: ReadonlyArray<string | null | undefined>,
): boolean {
  return pathRoles.some((role) => role != null && COMPOSER_KEY_OWNING_ROLE_SET.has(role));
}
