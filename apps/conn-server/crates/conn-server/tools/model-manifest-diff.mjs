#!/usr/bin/env node
// `model-manifest.json`: the text the T3 server writes for a fetched manifest
// (`encodeManifestCache` in apps/server/src/provider/ModelManifest.ts) against the text this
// server writes (`examples/model_manifest_cache`), for the manifest bundled at the pin. Also
// checks that both accept that manifest. No network, no model.
//
//   node crates/conn-server/tools/model-manifest-diff.mjs <examples/model_manifest_cache>
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import { importSource, inMonorepo, packageImporter } from "../../../tools/monorepo.mjs";
import { sealedEnvTemp } from "../../../tools/sealed-env.mjs";

const example = process.argv[2];
if (example === undefined || !NodeFS.existsSync(example)) {
  console.error("usage: model-manifest-diff.mjs <examples/model_manifest_cache>");
  process.exit(2);
}
const bundledFile = inMonorepo("apps/server/src/provider/model-manifest.json");
const { encodeManifestCache, BUNDLED_MODEL_MANIFEST } = await importSource(
  "apps/server/src/provider/ModelManifest.ts",
);
const Effect = await packageImporter("apps/server")("effect/Effect");

let failures = 0;
for (const fetchedAtMs of [0, 1790000000123]) {
  const t3 = Effect.runSync(encodeManifestCache({ fetchedAtMs, manifest: BUNDLED_MODEL_MANIFEST }));
  const ours = NodeChildProcess.execFileSync(example, [bundledFile, String(fetchedAtMs)], {
    encoding: "utf8",
    env: sealedEnvTemp(),
  });
  if (t3 === ours) {
    console.log(`ok   fetchedAtMs ${fetchedAtMs}: ${ours.length} bytes, the same`);
  } else {
    failures++;
    let at = 0;
    while (at < t3.length && t3[at] === ours[at]) at++;
    console.log(`FAIL fetchedAtMs ${fetchedAtMs}: differs at byte ${at}`);
    console.log(`  T3:   …${t3.slice(Math.max(0, at - 80), at + 80)}`);
    console.log(`  Conn: …${ours.slice(Math.max(0, at - 80), at + 80)}`);
  }
}
// Orbit reads `manifest.providers[driver].models[].slug` and `aliases` from the file.
const providers = Object.keys(BUNDLED_MODEL_MANIFEST.providers ?? {});
console.log(`providers in the bundled manifest: ${providers.join(", ")}`);
process.exit(failures === 0 ? 0 : 1);
