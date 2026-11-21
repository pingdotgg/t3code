import { Atom } from "effect/reactivity";

import type { SettingsPage } from "../settings/SettingsNav";

/** Set from any screen to open that settings page; null shows the board. */
export const settingsPageAtom = Atom.make<SettingsPage | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("settings-page"),
);
