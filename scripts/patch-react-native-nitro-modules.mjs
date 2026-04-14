import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

const candidates = [join(root, "node_modules/react-native-nitro-modules/package.json")];

const bunStorePath = join(root, "node_modules/.bun");

if (existsSync(bunStorePath)) {
  for (const entry of readdirSync(bunStorePath)) {
    if (!entry.startsWith("react-native-nitro-modules@")) {
      continue;
    }

    candidates.push(
      join(bunStorePath, entry, "node_modules/react-native-nitro-modules/package.json"),
    );
  }
}

let patchedCount = 0;
let locatedCount = 0;

for (const filePath of candidates) {
  if (!existsSync(filePath)) {
    continue;
  }

  locatedCount += 1;

  const source = readFileSync(filePath, "utf8");
  const pkg = JSON.parse(source);

  if (pkg.codegenConfig == null || typeof pkg.codegenConfig !== "object") {
    throw new Error(
      `Found react-native-nitro-modules package at ${filePath}, but codegenConfig was missing.`,
    );
  }

  const iosConfig =
    pkg.codegenConfig.ios != null && typeof pkg.codegenConfig.ios === "object"
      ? pkg.codegenConfig.ios
      : {};

  const modulesProvider =
    iosConfig.modulesProvider != null && typeof iosConfig.modulesProvider === "object"
      ? iosConfig.modulesProvider
      : {};

  if (modulesProvider.NitroModules === "NativeNitroModules") {
    continue;
  }

  modulesProvider.NitroModules = "NativeNitroModules";
  iosConfig.modulesProvider = modulesProvider;
  pkg.codegenConfig.ios = iosConfig;

  writeFileSync(filePath, `${JSON.stringify(pkg, null, 2)}\n`);
  patchedCount += 1;
}

if (patchedCount > 0) {
  console.log(
    `[patch-react-native-nitro-modules] patched ${patchedCount} react-native-nitro-modules installation(s).`,
  );
} else if (locatedCount > 0) {
  console.log("[patch-react-native-nitro-modules] react-native-nitro-modules already patched.");
} else {
  console.log(
    "[patch-react-native-nitro-modules] react-native-nitro-modules not installed; skipping.",
  );
}
