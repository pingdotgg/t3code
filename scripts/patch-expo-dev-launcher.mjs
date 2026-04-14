import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

const candidates = [join(root, "node_modules/expo-dev-launcher/ios/EXDevLauncherController.m")];

const bunStorePath = join(root, "node_modules/.bun");

if (existsSync(bunStorePath)) {
  for (const entry of readdirSync(bunStorePath)) {
    if (!entry.startsWith("expo-dev-launcher@")) {
      continue;
    }

    candidates.push(
      join(bunStorePath, entry, "node_modules/expo-dev-launcher/ios/EXDevLauncherController.m"),
    );
  }
}

const targetLine = "[manager updateCurrentBridge:self.appBridge];";
const replacement = [
  "  // Expo SDK 55's dev launcher still references `self.appBridge`,",
  "  // but React Native 0.83 removed that property from the delegate base class.",
  "  // Newer Expo builds stop updating the dev menu bridge here.",
].join("\n");

let patchedCount = 0;
let locatedCount = 0;

for (const filePath of candidates) {
  if (!existsSync(filePath)) {
    continue;
  }

  locatedCount += 1;
  const source = readFileSync(filePath, "utf8");

  if (source.includes(replacement)) {
    continue;
  }

  if (!source.includes(targetLine)) {
    throw new Error(
      `Found expo-dev-launcher source at ${filePath}, but the expected bridge line was missing.`,
    );
  }

  const nextSource = source.replace(`  ${targetLine}`, replacement);
  writeFileSync(filePath, nextSource);
  patchedCount += 1;
}

if (patchedCount > 0) {
  console.log(
    `[patch-expo-dev-launcher] patched ${patchedCount} expo-dev-launcher installation(s).`,
  );
} else if (locatedCount > 0) {
  console.log("[patch-expo-dev-launcher] expo-dev-launcher already patched.");
} else {
  console.log("[patch-expo-dev-launcher] expo-dev-launcher not installed; skipping.");
}
