#!/usr/bin/env node
// @effect-diagnostics globalConsole:off
// @effect-diagnostics nodeBuiltinImport:off

import { existsSync, readFileSync } from "node:fs";

import {
  seedOwnerPairingTokenFromEnv,
  resolveOwnerPairingUrl,
  type OwnerPairingState,
} from "./owner-pairing-token.ts";

function loadLocalEnvFile(filePath: string): void {
  if (!existsSync(filePath)) {
    return;
  }

  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1);
    if (key.length > 0 && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadLocalEnvFile(".env.local");
loadLocalEnvFile(".env");

const explicitState = process.env.T3CODE_OWNER_PAIRING_STATE?.trim();
const states: ReadonlyArray<OwnerPairingState> =
  explicitState === "dev" || explicitState === "userdata" ? [explicitState] : ["userdata", "dev"];
const dbPaths = states.flatMap((state) => {
  const dbPath = seedOwnerPairingTokenFromEnv(process.env, state);
  return dbPath ? [dbPath] : [];
});

if (dbPaths.length === 0) {
  console.log("T3CODE_OWNER_PAIRING_TOKEN is not set; no stable owner pairing token was seeded.");
  process.exit(0);
}

for (const dbPath of dbPaths) {
  console.log(`Seeded stable owner pairing token in ${dbPath}`);
}
console.log(resolveOwnerPairingUrl(process.env) ?? "Pairing URL unavailable.");
