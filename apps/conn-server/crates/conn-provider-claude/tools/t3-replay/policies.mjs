#!/usr/bin/env node
// Prints the runtime policy the T3 replay harness gives each Claude scenario, read from the
// T3 server's own fixture table (testkit/fixtures/index.ts): the thread's runtime and
// interaction mode from the fixture input, and the scenario's `runtimePolicyOverride`
// (RuntimePolicy.layerWithOverride). Nothing is copied by hand, so a fixture change shows.
//
//   node policies.mjs <conn monorepo> > policies.json

import "../../../../tools/no-outside-fetch.mjs";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("usage: policies.mjs <conn monorepo>");
  process.exit(2);
}
const index = NodePath.join(root, "apps/server/src/orchestration-v2/testkit/fixtures/index.ts");
const mod = await import(NodeURL.pathToFileURL(index).href);
const table = Object.values(mod).find((v) => Array.isArray(v) && v.some((s) => s?.providers));
if (!table) {
  console.error(`no fixture table in ${index}`);
  process.exit(1);
}
const out = {};
for (const scenario of table) {
  for (const provider of scenario.providers ?? []) {
    if (String(provider.driver) !== "claudeAgent") continue;
    const input = scenario.buildInput();
    out[scenario.name] = {
      runtimeMode: input.runtimeMode ?? "full-access",
      interactionMode: input.interactionMode ?? "default",
      ...(provider.runtimePolicyOverride ?? {}),
    };
  }
}
console.log(JSON.stringify(out, null, 2));
