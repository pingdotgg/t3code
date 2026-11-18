#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A one-shot CI check; synchronous Node APIs keep it small.
// Conn: fails when a GT catalog names the app literally instead of `{appName}`. The lint rule
// t3code/no-hardcoded-app-name covers source strings. See FORK.md, "i18n and the app name".
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { catalogBrandHits, catalogFiles } from "./conn-brand.ts";

const root = NodePath.resolve(import.meta.dirname, "..");
const hits = catalogFiles(root).flatMap((file) =>
  catalogBrandHits(NodePath.relative(root, file), JSON.parse(NodeFS.readFileSync(file, "utf8"))),
);

if (hits.length > 0) {
  for (const hit of hits) console.error(`${hit.file}: ${hit.key} ${JSON.stringify(hit.text)}`);
  console.error(
    `\n${hits.length} catalog entries name the app literally. Write {appName} in the source copy, pass { appName: appName() }, run \`vp run i18n:generate\`, and put {appName} in each translation.`,
  );
  process.exit(1);
}
console.log(`No catalog names the app literally (${catalogFiles(root).length} catalogs).`);
