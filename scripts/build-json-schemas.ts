import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  KEYBINDINGS_SCHEMA_RELATIVE_PATH,
  writeKeybindingsJsonSchemas,
} from "./lib/keybindings-schema.ts";
import {
  SERVER_SETTINGS_SCHEMA_RELATIVE_PATH,
  writeServerSettingsJsonSchemas,
} from "./lib/server-settings-schema.ts";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

writeServerSettingsJsonSchemas({ rootDir });
writeKeybindingsJsonSchemas({ rootDir });

console.log(`Wrote ${SERVER_SETTINGS_SCHEMA_RELATIVE_PATH}`);
console.log(`Wrote ${KEYBINDINGS_SCHEMA_RELATIVE_PATH}`);
