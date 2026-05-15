import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const packageJsonPath = join(extensionDir, "package.json");
const packageJsonSource = readFileSync(packageJsonPath, "utf8");
const packageJson = JSON.parse(packageJsonSource);
const packageOptions = parsePackageOptions(process.argv.slice(2));
const publisher = process.env.VSCE_PUBLISHER?.trim();
const targetSuffix = packageOptions.target ? `-${packageOptions.target}` : "";
const vsixName = `${packageJson.name}-${packageJson.version}${targetSuffix}.vsix`;
const vsixPath = packageOptions.out
  ? resolveExtensionPath(packageOptions.out)
  : join(extensionDir, vsixName);

if (!publisher) {
  throw new Error("VSCE_PUBLISHER must be set before packaging the VS Code extension.");
}

function parsePackageOptions(args) {
  const options = {
    out: undefined,
    preRelease: false,
    target: undefined,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--out") {
      options.out = requireValue(args, (index += 1), arg);
      continue;
    }

    if (arg === "--pre-release") {
      options.preRelease = true;
      continue;
    }

    if (arg === "--target") {
      options.target = requireValue(args, (index += 1), arg);
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

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: extensionDir,
    shell: process.platform === "win32",
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

rmSync(vsixPath, { force: true });
rmSync(join(extensionDir, "dist", vsixName), { force: true });

try {
  writeFileSync(packageJsonPath, `${JSON.stringify({ ...packageJson, publisher }, null, 2)}\n`);
  run("bun", ["run", "build"]);
  const vsceArgs = ["x", "vsce", "package", "--no-dependencies", "--out", vsixPath];
  if (packageOptions.target) {
    vsceArgs.push("--target", packageOptions.target);
  }
  if (packageOptions.preRelease) {
    vsceArgs.push("--pre-release");
  }
  run("bun", vsceArgs);
} finally {
  writeFileSync(packageJsonPath, packageJsonSource);
}
