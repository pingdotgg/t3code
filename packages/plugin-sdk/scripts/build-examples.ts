// @effect-diagnostics nodeBuiltinImport:off - a plain Node build script with no Effect runtime: it
// lists the example folders.
// Builds each example's web half to its dist/web.js with the example's own vite.config.ts.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { build } from "vite-plus";

const examples = NodePath.join(import.meta.dirname, "../examples");
for (const name of NodeFS.readdirSync(examples).toSorted()) {
  const configFile = NodePath.join(examples, name, "vite.config.ts");
  if (NodeFS.existsSync(configFile)) await build({ configFile, logLevel: "warn" });
}
