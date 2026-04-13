import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseCliArgs } from "@t3tools/shared/cliArgs";

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

  return { changed };
}

export function parseArgs(argv: ReadonlyArray<string>): {
  version: string;
  rootDir: string | undefined;
  writeGithubOutput: boolean;
} {
  const { flags, positionals } = parseCliArgs(argv, { booleanFlags: ["github-output"] });

  const unknownFlags = Object.keys(flags).filter((k) => k !== "github-output" && k !== "root");
  if (unknownFlags.length > 0) {
    throw new Error(`Unknown argument: --${unknownFlags[0]}`);
  }

  if ("root" in flags && flags.root === null) {
    throw new Error("Missing value for --root.");
  }

  if (positionals.length > 1) {
    throw new Error("Only one release version can be provided.");
  }

  if (positionals.length !== 1 || !positionals[0]) {
    throw new Error(
      "Usage: node scripts/update-release-package-versions.ts <version> [--root <path>] [--github-output]",
    );
  }

  return {
    version: positionals[0],
    rootDir: flags.root ?? undefined,
    writeGithubOutput: "github-output" in flags,
  };
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
    console.log("All package.json versions already match release version.");
  }

  if (writeGithubOutput) {
    const githubOutputPath = process.env.GITHUB_OUTPUT;
    if (!githubOutputPath) {
      throw new Error("GITHUB_OUTPUT is required when --github-output is set.");
    }
    appendFileSync(githubOutputPath, `changed=${changed}\n`);
  }
}
