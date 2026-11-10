// @effect-diagnostics nodeBuiltinImport:off - standalone catalog generation uses synchronous Node I/O.
// @effect-diagnostics globalConsole:off - standalone maintenance command output.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import { catalog } from "@handy-computer/models";
import * as Schema from "effect/Schema";

import manifest from "../package.json" with { type: "json" };
import { renderSpeechCatalog } from "./speech-catalog.ts";

const require = NodeModule.createRequire(import.meta.url);
const source = require.resolve("@handy-computer/models/catalog.json");
const sourceManifest = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
)(NodeFS.readFileSync(NodePath.join(NodePath.dirname(source), "package.json"), "utf8"));
if (sourceManifest.version !== manifest.devDependencies["@handy-computer/models"]) {
  throw new Error("Install the exact pinned @handy-computer/models version before generating.");
}
const target = new URL("../src/speech/catalog.json", import.meta.url);
const expected = await renderSpeechCatalog(
  catalog.data,
  sourceManifest.version,
  manifest.dependencies["transcribe-cpp"],
);
if (process.argv.includes("--check")) {
  if (NodeFS.readFileSync(target, "utf8") !== expected) {
    throw new Error("Speech catalog differs; run vp run speech:catalog:sync in apps/server.");
  }
  console.log("Bundled speech catalog matches the pinned source.");
} else {
  NodeFS.writeFileSync(target, expected);
  console.log(`Generated speech catalog from @handy-computer/models@${sourceManifest.version}.`);
}
