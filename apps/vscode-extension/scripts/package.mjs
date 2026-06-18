import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { filterPackagedDependencies } from "./package-dependencies.mjs";

const extensionDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const packageJsonPath = join(extensionDir, "package.json");
const packageJsonSource = readFileSync(packageJsonPath, "utf8");
const packageJson = JSON.parse(packageJsonSource);
const packageOptions = parsePackageOptions(process.argv.slice(2));
const configuredPublisher = process.env.VSCE_PUBLISHER?.trim();
const publisher = configuredPublisher || "t3tools";
if (!/^[a-z0-9][a-z0-9-]*$/i.test(publisher)) {
  throw new Error(
    `Invalid VSCE publisher name: "${publisher}". Must start with an alphanumeric character and contain only alphanumeric characters or hyphens.`,
  );
}
const targetSuffix = packageOptions.target ? `-${packageOptions.target}` : "";
const vsixName = `${packageJson.name}-${packageJson.version}${targetSuffix}.vsix`;
const vsixPath = packageOptions.out
  ? resolveExtensionPath(packageOptions.out)
  : join(extensionDir, vsixName);

function parsePackageOptions(args) {
  const options = {
    out: undefined,
    preRelease: false,
    target: undefined,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--out") {
      index += 1;
      options.out = requireValue(args, index, arg);
      continue;
    }

    if (arg === "--pre-release") {
      options.preRelease = true;
      continue;
    }

    if (arg === "--target") {
      index += 1;
      options.target = requireValue(args, index, arg);
      continue;
    }

    throw new Error(`Unknown package option: ${arg}`);
  }

  return options;
}

function requireValue(args, index, optionName) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function resolveExtensionPath(path) {
  return isAbsolute(path) ? path : join(extensionDir, path);
}

function isWindowsHost() {
  return process.env.OS === "Windows_NT";
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: extensionDir,
    shell: isWindowsHost(),
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

let packageJsonRestored = false;
function restorePackageJson() {
  if (packageJsonRestored) {
    return;
  }
  writeFileSync(packageJsonPath, packageJsonSource);
  packageJsonRestored = true;
}

function restorePackageJsonAndExit(exitCode) {
  restorePackageJson();
  process.exit(exitCode);
}

process.once("SIGINT", () => restorePackageJsonAndExit(130));
process.once("SIGTERM", () => restorePackageJsonAndExit(143));

rmSync(vsixPath, { force: true });
rmSync(join(extensionDir, "dist", vsixName), { force: true });

try {
  if (!configuredPublisher) {
    console.warn(
      `VSCE_PUBLISHER is not set; packaging a local VSIX with publisher "${publisher}".`,
    );
  }
  const packagedPackageJson = {
    ...packageJson,
    publisher,
    dependencies: filterPackagedDependencies(packageJson.dependencies),
  };
  delete packagedPackageJson.private;
  writeFileSync(packageJsonPath, `${JSON.stringify(packagedPackageJson, null, 2)}\n`);
  run("pnpm", ["run", "build"]);
  const vsceArgs = ["exec", "vsce", "package", "--no-dependencies", "--out", vsixPath];
  if (packageOptions.target) {
    vsceArgs.push("--target", packageOptions.target);
  }
  if (packageOptions.preRelease) {
    vsceArgs.push("--pre-release");
  }
  run("pnpm", vsceArgs);
} finally {
  restorePackageJson();
}
