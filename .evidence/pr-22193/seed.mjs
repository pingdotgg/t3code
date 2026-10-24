#!/usr/bin/env node
// Writes a matrix seed into <worktree>/.t3/userdata/settings.json.
// Only run while that worktree's dev server is stopped.
// Usage: node seed.mjs <worktree> <seed>
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const [worktree, seedName] = process.argv.slice(2);
if (!worktree || !seedName) {
  console.error("usage: seed.mjs <worktree> <seed>");
  process.exit(2);
}

const claude = (model, effort) => ({
  instanceId: "claudeAgent",
  model,
  ...(effort ? { options: [{ id: "effort", value: effort }] } : {}),
});
const claudeOff = { claudeAgent: { driver: "claudeAgent", enabled: false } };

const SEEDS = {
  "S-base": { defaultModelSelection: claude("claude-opus-4-8", "high") },
  "S-off": {
    defaultModelSelection: claude("claude-opus-4-8", "high"),
    providerInstances: claudeOff,
  },
  "S-unavail": {
    defaultModelSelection: claude("claude-opus-4-8", "high"),
    providerInstances: { claudeAgent: { driver: "claudeAgent", config: { binaryPath: 123 } } },
  },
  "S-absent": {
    defaultModelSelection: { ...claude("claude-opus-4-8", "high"), instanceId: "claude_work" },
  },
  "S-hidden": {
    defaultModelSelection: claude("claude-opus-4-8", "high"),
    providerModelPreferences: {
      claudeAgent: { hiddenModels: ["claude-opus-4-8"], modelOrder: [] },
    },
  },
  "S-opus45-xhigh": { defaultModelSelection: claude("claude-opus-4-5", "xhigh") },
  "S-opus45-xhigh-off": {
    defaultModelSelection: claude("claude-opus-4-5", "xhigh"),
    providerInstances: claudeOff,
  },
  "S-haiku45": { defaultModelSelection: claude("claude-haiku-4-5") },
  "S-haiku45-off": {
    defaultModelSelection: claude("claude-haiku-4-5"),
    providerInstances: claudeOff,
  },
};

const seed = SEEDS[seedName];
if (!seed) {
  console.error(`unknown seed ${seedName}; known: ${Object.keys(SEEDS).join(", ")}`);
  process.exit(2);
}

const dir = NodePath.join(worktree, ".t3", "userdata");
const file = NodePath.join(dir, "settings.json");
NodeFS.mkdirSync(dir, { recursive: true });
const current = NodeFS.existsSync(file) ? JSON.parse(NodeFS.readFileSync(file, "utf8")) : {};
for (const key of ["defaultModelSelection", "providerInstances", "providerModelPreferences"]) {
  delete current[key];
}
NodeFS.writeFileSync(file, `${JSON.stringify({ ...current, ...seed }, null, 2)}\n`);
console.log(`${seedName} -> ${file}`);
