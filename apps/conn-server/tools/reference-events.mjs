#!/usr/bin/env node
// After the provider capture tools ran (tools/bump-conn.sh --capture): compares each reference
// file with its copy from before, puts back every file whose content did not change, and
// prints the files that did. So `git diff` shows only real changes.
//
//   node tools/reference-events.mjs <before root> <dir> [<dir> ...]
//
// <dir> is a path in this repository; <before root>/<dir> holds its earlier copy. A JSON file
// is compared after normalizing what changes on every capture: the top-level `note` and
// `capturedOn`; `…At` times on the capture day (the replay tests read them as "now"); the
// random part of a temp folder name; an event's `driver`, which the capture tools drop; the
// test-clock stamp on a turn input's provider thread, which moves between runs; and
// uuids (numbered by first appearance, so a changed uuid order still shows).
// Other files are compared byte for byte. Prints `changed <path>`, `added <path>` and
// `removed <path>` lines and a summary line. Always exits 0: a change is for a person to read.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { repoRoot } from "./monorepo.mjs";

const [beforeRoot, ...dirs] = process.argv.slice(2);
if (!beforeRoot || dirs.length === 0) {
  console.error("usage: reference-events.mjs <before root> <dir> [<dir> ...]");
  process.exit(2);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// mkdtemp's six random characters at the end of a folder right under the temp root.
const TEMP_DIR = /(\/(?:private\/)?(?:var\/folders\/[^/"]+\/[^/"]+\/T|tmp)\/[^/"]*?)[A-Za-z0-9]{6}(?=[/"\\])/g;

/** The content that matters: JSON without the capture's own noise, else the raw text. */
function normalized(file) {
  const text = NodeFS.readFileSync(file, "utf8");
  if (!file.endsWith(".json")) return text;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  let day;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    day = typeof value.capturedOn === "string" ? value.capturedOn : undefined;
    delete value.note;
    delete value.capturedOn;
    if (Array.isArray(value.events)) {
      for (const event of value.events) if (event && typeof event === "object") delete event.driver;
    }
    // The test clock's stamp on a later turn's input moves by a millisecond from run to run.
    if (Array.isArray(value.startTurn)) {
      for (const input of value.startTurn) {
        if (input?.providerThread && typeof input.providerThread === "object") {
          delete input.providerThread.updatedAt;
        }
      }
    }
  }
  const scrub = (node) => {
    if (Array.isArray(node)) return node.map(scrub);
    if (node === null || typeof node !== "object") return node;
    return Object.fromEntries(
      Object.entries(node).map(([key, v]) => [
        key,
        typeof v === "string" && key.endsWith("At") && day !== undefined && v.startsWith(`${day}T`)
          ? "<now>"
          : scrub(v),
      ]),
    );
  };
  const seen = new Map();
  return JSON.stringify(scrub(value))
    .replace(TEMP_DIR, "$1<tmp>")
    .replace(UUID, (uuid) => {
    const key = uuid.toLowerCase();
    if (!seen.has(key)) seen.set(key, `<uuid-${seen.size + 1}>`);
    return seen.get(key);
  });
}

const files = (dir) =>
  NodeFS.existsSync(dir)
    ? NodeFS.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort()
    : [];

let changed = 0;
let kept = 0;
for (const dir of dirs) {
  const now = NodePath.join(repoRoot, dir);
  const before = NodePath.join(beforeRoot, dir);
  const names = new Set([...files(now), ...files(before)]);
  for (const name of [...names].sort()) {
    const a = NodePath.join(before, name);
    const b = NodePath.join(now, name);
    const rel = NodePath.join(dir, name);
    if (!NodeFS.existsSync(b)) {
      console.log(`removed ${rel}`);
      changed++;
    } else if (!NodeFS.existsSync(a)) {
      console.log(`added   ${rel}`);
      changed++;
    } else if (normalized(a) === normalized(b)) {
      NodeFS.copyFileSync(a, b);
      kept++;
    } else {
      console.log(`changed ${rel}`);
      changed++;
    }
  }
}
console.log(`reference events: ${changed} changed, ${kept} unchanged (put back as they were)`);
