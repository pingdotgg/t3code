// Top-level await only in an imported module: refused on every runtime.
import { settings } from "./asyncSettings.mjs";

export function activate(context) {
  context.log.info(settings.greeting);
}
