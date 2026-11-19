import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { handle } from "../engine/hook.mjs";

/** Returns the JSON to print for one hook payload, or an empty string when the hook stays silent. */
export function run(rawInput, env) {
  const output = handle(JSON.parse(rawInput), env);
  return output ? JSON.stringify(output) : "";
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  process.stdout.write(run(NodeFS.readFileSync(0, "utf8"), process.env));
}
