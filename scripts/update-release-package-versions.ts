import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writeKeybindingsJsonSchemas } from "./lib/keybindings-schema.ts";
import { writeServerSettingsJsonSchemas } from "./lib/server-settings-schema.ts";

export const releasePackageFiles = [
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
] as const;

interface UpdateReleasePackageVersionsOptions {
  readonly rootDir?: string;
}

interface MutablePackageJson {
  version?: string;
  [key: string]: unknown;
}

export function updateReleasePackageVersions(
  version: string,
  options: UpdateReleasePackageVersionsOptions = {},
): { changed: boolean } {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  let changed = false;

  for (const relativePath of releasePackageFiles) {
    const filePath = resolve(rootDir, relativePath);
    const packageJson = JSON.parse(readFileSync(filePath, "utf8")) as MutablePackageJson;
    if (packageJson.version === version) {
      continue;
    }

    packageJson.version = version;
    writeFileSync(filePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    changed = true;
  }

  changed = writeServerSettingsJsonSchemas({ rootDir, version }).changed || changed;
  changed = writeKeybindingsJsonSchemas({ rootDir, version }).changed || changed;

  return { changed };
}

function parseArgs(argv: ReadonlyArray<string>): {
  version: string;
  rootDir: string | undefined;
  writeGithubOutput: boolean;
} {
  let version: string | undefined;
  let rootDir: string | undefined;
  let writeGithubOutput = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }

    if (argument === "--github-output") {
      writeGithubOutput = true;
      continue;
    }

    if (argument === "--root") {
      rootDir = argv[index + 1];
      if (!rootDir) {
        throw new Error("Missing value for --root.");
      }
      index += 1;
      continue;
    }

    if (argument.startsWith("--")) {
      throw new Error(`Unknown argument: ${argument}`);
    }

    if (version !== undefined) {
      throw new Error("Only one release version can be provided.");
    }
    version = argument;
  }

  if (!version) {
    throw new Error(
      "Usage: node scripts/update-release-package-versions.ts <version> [--root <path>] [--github-output]",
    );
  }

  return { version, rootDir, writeGithubOutput };
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const { version, rootDir, writeGithubOutput } = parseArgs(process.argv.slice(2));
  const { changed } = updateReleasePackageVersions(
    version,
    rootDir === undefined ? {} : { rootDir },
  );

  if (!changed) {
    console.log("All release version artifacts already match the requested version.");
  }

  if (writeGithubOutput) {
    const githubOutputPath = process.env.GITHUB_OUTPUT;
    if (!githubOutputPath) {
      throw new Error("GITHUB_OUTPUT is required when --github-output is set.");
    }
    appendFileSync(githubOutputPath, `changed=${changed}\n`);
  }
}
