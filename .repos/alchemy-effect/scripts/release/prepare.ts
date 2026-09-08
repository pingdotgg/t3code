import { $ } from "bun";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type Channel = "release" | "beta" | "alpha" | "rc" | "tag";

const spec = (process.argv[2] ?? "").trim();
const forceLatest = process.env.FORCE_LATEST === "true";
const root = path.resolve(import.meta.dir, "../..");
const entries = await readdir(path.join(root, "packages"), {
  withFileTypes: true,
});
const packages = (
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const dir = `packages/${entry.name}`;
        const manifest = JSON.parse(
          await readFile(path.join(root, dir, "package.json"), "utf8"),
        );
        return manifest.private === true ? undefined : { dir, manifest };
      }),
  )
).filter((pkg) => pkg !== undefined);

async function versions(name: string): Promise<Array<string>> {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(name)}`,
  );
  if (!response.ok) return [];
  const json = (await response.json()) as {
    versions?: Record<string, unknown>;
  };
  return Object.keys(json.versions ?? {});
}

function compare(a: string, b: string): number {
  const aa = a.split(".").map(Number);
  const bb = b.split(".").map(Number);
  return aa[0]! - bb[0]! || aa[1]! - bb[1]! || aa[2]! - bb[2]!;
}

let channel: Channel;
let version: string;
const prerelease = spec.match(/^(beta|alpha|rc)(?:\.(\d+))?$/);
if (spec === "" || prerelease) {
  channel = (prerelease?.[1] ?? "beta") as Channel;
  const explicit = prerelease?.[2];
  if (explicit) {
    version = `2.0.0-${channel}.${explicit}`;
  } else {
    const maxima = await Promise.all(
      packages.map(async ({ manifest }) => {
        const matcher = new RegExp(`^2\\.0\\.0-${channel}\\.(\\d+)$`);
        return Math.max(
          0,
          ...(await versions(manifest.name)).map((candidate) =>
            Number(candidate.match(matcher)?.[1] ?? 0),
          ),
        );
      }),
    );
    const maximum = Math.max(0, ...maxima);
    const remoteTag =
      maximum > 0
        ? await $`git ls-remote --exit-code --tags origin ${`refs/tags/v2.0.0-${channel}.${maximum}`}`
            .nothrow()
            .quiet()
        : undefined;
    const complete = maximum > 0 && maxima.every((value) => value === maximum);
    const next =
      complete && remoteTag?.exitCode === 0 ? maximum + 1 : maximum || 1;
    version = `2.0.0-${channel}.${next}`;
  }
} else if (/^\d+\.\d+\.\d+$/.test(spec)) {
  channel = "release";
  version = spec;
} else if (["patch", "minor", "major"].includes(spec)) {
  channel = "release";
  const stable = (await versions(packages[0]!.manifest.name))
    .filter((candidate) => /^\d+\.\d+\.\d+$/.test(candidate))
    .sort(compare)
    .at(-1);
  if (!stable)
    throw new Error(
      "Cannot calculate a stable bump without a published stable version",
    );
  let [major, minor, patch] = stable.split(".").map(Number) as [
    number,
    number,
    number,
  ];
  if (spec === "major") [major, minor, patch] = [major + 1, 0, 0];
  if (spec === "minor") [minor, patch] = [minor + 1, 0];
  if (spec === "patch") patch += 1;
  version = `${major}.${minor}.${patch}`;
} else {
  if (!/^[A-Za-z][A-Za-z0-9.-]*$/.test(spec))
    throw new Error(`Invalid release spec: ${spec}`);
  channel = "tag";
  version = `0.0.0-${spec}`;
}

for (const pkg of packages) {
  pkg.manifest.version = version;
  await writeFile(
    path.join(root, pkg.dir, "package.json"),
    `${JSON.stringify(pkg.manifest, null, 2)}\n`,
  );
}
await writeFile(
  path.join(root, "release-packages.json"),
  `${JSON.stringify(
    packages.map(({ dir, manifest }) => ({ dir, name: manifest.name })),
    null,
    2,
  )}\n`,
);

await $`pnpm install --lockfile-only`.cwd(root).quiet();
// stdout is piped into $GITHUB_OUTPUT by the workflow, so keep subcommand
// logs on stderr — only the key=value lines below may reach stdout.
const validation = await $`bun validate:publish-packages`.cwd(root).quiet();
console.error(validation.stdout.toString().trimEnd());

const tag = forceLatest
  ? "latest"
  : channel === "release"
    ? "latest"
    : channel === "tag"
      ? version.slice("0.0.0-".length).replaceAll(".", "-")
      : "next";
console.log(`version=${version}`);
console.log(`channel=${channel}`);
console.log(`tag=${tag}`);
