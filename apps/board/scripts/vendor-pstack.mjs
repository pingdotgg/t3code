#!/usr/bin/env node
// Copies the two skills that ride in the orchestrator's system prompt out of a pstack-t3 checkout
// into apps/board/pstack/, without their front matter. Run it after every pstack-t3 change to either skill.
// Usage: node apps/board/scripts/vendor-pstack.mjs <pstack-t3 checkout>
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const OUT_DIR = NodeURL.fileURLToPath(new URL("../pstack", import.meta.url));
const SKILLS = ["poteto-mode", "pstack-t3"];

const body = (text) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, "");

/** Writes `<out>/<skill>.md` for each skill and returns the paths written. */
export function vendor(checkout, out = OUT_DIR) {
  NodeFS.mkdirSync(out, { recursive: true });
  return SKILLS.map((skill) => {
    const text = NodeFS.readFileSync(NodePath.join(checkout, "skills", skill, "SKILL.md"), "utf8");
    const file = NodePath.join(out, `${skill}.md`);
    NodeFS.writeFileSync(file, body(text));
    return file;
  });
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const checkout = process.argv[2];
  if (!checkout) {
    console.error("Usage: node apps/board/scripts/vendor-pstack.mjs <pstack-t3 checkout>");
    process.exit(1);
  }
  for (const file of vendor(NodePath.resolve(checkout))) console.log(file);
}
