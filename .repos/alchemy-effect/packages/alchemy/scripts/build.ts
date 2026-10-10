import { $ } from "bun";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import packageJson from "../package.json" with { type: "json" };

const packageDirectory = resolve(import.meta.dir, "..");
const now = performance.now();

const exports = Object.fromEntries(
  Object.entries(packageJson.exports).map(([subpath, source]) => {
    if (source === null) {
      return [subpath, null];
    }

    // Bin entrypoints are plain JavaScript in both checkout and published use.
    if (subpath.startsWith("./bin/")) {
      return [subpath, source];
    }

    // Bootstrap modules are source inputs to the deployment bundler.
    if (subpath === "./Runtime/Bootstrap/*") {
      return [subpath, { types: source, bun: source, default: source }];
    }

    const output = source.replace(/^\.\/src\//, "./lib/");
    return [
      subpath,
      {
        types: output.replace(/\.tsx?$/, ".d.ts"),
        bun: source,
        default: output.replace(/\.tsx?$/, ".js"),
      },
    ];
  }),
);

await Bun.write(
  join(packageDirectory, "package.json"),
  JSON.stringify(
    {
      ...packageJson,
      publishConfig: { ...packageJson.publishConfig, exports },
    },
    null,
    2,
  ) + "\n",
);

await rm(join(packageDirectory, "lib"), { recursive: true, force: true });
console.log(`Building ${packageJson.name} v${packageJson.version}...`);
await $`tsc -b --force`.cwd(packageDirectory);
await $`bun ../../scripts/copy-package-files.ts alchemy`.cwd(packageDirectory);
console.log(`Built in ${Math.round(performance.now() - now) / 1000}s`);
