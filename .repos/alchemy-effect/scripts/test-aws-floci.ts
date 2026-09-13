/**
 * Run the live AWS suites for services that have a Floci local provider
 * (`flociDual` / `ProviderLayer.dual` in Providers.ts) under
 * `ALCHEMY_TEST_DEV=1`.
 *
 * Dedicated `*.local.test.ts` files are excluded — those already set
 * `Test.make({ dev: true })` and some use `Alchemy.remote()` for out-of-band
 * live checks, which this env would redirect onto the emulator.
 *
 * Extra alchemy-test args are forwarded (`-t`, `--retry`, paths, …).
 */
import { Glob } from "bun";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const alchemyRoot = join(repoRoot, "packages/alchemy");
const awsTestRoot = join(alchemyRoot, "test/AWS");
const providersFile = join(alchemyRoot, "src/AWS/Providers.ts");

const extraDirs: Record<string, ReadonlyArray<string>> = {
  SecretsManager: ["Secret"],
};

const dualizedServices = (): string[] => {
  const source = readFileSync(providersFile, "utf8");
  const names = new Set<string>(["Local"]);
  const pattern = /(?:flociDual|ProviderLayer\.dual)\(\s*([A-Za-z0-9]+)\./g;
  for (const match of source.matchAll(pattern)) {
    const service = match[1]!;
    names.add(service);
    for (const extra of extraDirs[service] ?? []) names.add(extra);
  }
  return [...names].sort();
};

const flagsWithValue = new Set([
  "-t",
  "--test-name-pattern",
  "--timeout",
  "--retry",
  "--concurrency",
  "-c",
  "--profile",
]);

const flags: string[] = [];
const paths: string[] = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg.startsWith("-")) {
    flags.push(arg);
    if (
      flagsWithValue.has(arg) &&
      args[i + 1] &&
      !args[i + 1]!.startsWith("-")
    ) {
      flags.push(args[++i]!);
    }
    continue;
  }
  paths.push(arg);
}

const allowedRoots = dualizedServices()
  .map((service) => join(awsTestRoot, service))
  .filter((dir) => existsSync(dir));

if (allowedRoots.length === 0) {
  console.error("test:aws:floci: no dualized AWS service test dirs found");
  process.exit(1);
}

const requestedRoots =
  paths.length > 0 ? paths.map((p) => resolve(alchemyRoot, p)) : allowedRoots;

const files: string[] = [];
for (const root of requestedRoots) {
  if (!existsSync(root)) {
    files.push(relative(alchemyRoot, root));
    continue;
  }
  if (statSync(root).isFile()) {
    files.push(relative(alchemyRoot, root));
    continue;
  }
  const glob = new Glob("**/*.test.ts");
  for await (const file of glob.scan(root)) {
    if (file.endsWith(".local.test.ts")) continue;
    files.push(relative(alchemyRoot, join(root, file)));
  }
}

process.env.ALCHEMY_TEST_DEV = "1";

// Prefer a locally built `floci:dev` (pnpm floci:build) when it exists —
// that's how unreleased emulator patches get exercised by this suite. When
// it doesn't, leave the env unset so the floci package resolves the pinned
// release image; hard-defaulting to a missing image fails every suite's
// `docker run` before a single test can run.
if (!process.env.ALCHEMY_FLOCI_IMAGE) {
  const devImage = Bun.spawnSync(
    ["docker", "image", "inspect", "floci:dev"],
    { stdout: "ignore", stderr: "ignore" },
  );
  if (devImage.exitCode === 0) {
    process.env.ALCHEMY_FLOCI_IMAGE = "floci:dev";
    console.log("test:aws:floci: using locally built floci:dev image");
  } else {
    console.log(
      "test:aws:floci: no local floci:dev image (pnpm floci:build) — using the pinned release image",
    );
  }
}

if (!flags.includes("--profile")) {
  flags.unshift("--profile", "testing");
}
if (!flags.includes("--concurrency") && !flags.includes("-c")) {
  // Every concurrent file deploys real stacks against the LOCAL emulator —
  // in-process deploys, the shared sidecar child, and a Docker container per
  // Lambda cold start all scale with this number. 64 (tuned while the env
  // bug made this script run against live AWS, where concurrency is free)
  // ballooned to ~60GB RSS on a full-suite run; 12 was ~4.5GB but too slow.
  // 32 matches the live-suite sweet spot from AGENTS.md.
  flags.unshift("--concurrency", "32");
}

// The emulator container outlives any single run, so orphaned rows survive
// into the next one — and a hard kill (machine death, SIGKILL) skips every
// finalizer and `afterAll`, so orphans are routine rather than exceptional.
// They do not just linger; they actively break later runs: a fixed-name
// fixture collides (`DuplicateLoadBalancerName`), and a Glue table whose S3
// location was deleted fails unrelated Athena queries, because the query
// engine resolves the whole catalog.
//
// This is the emulator's counterpart to the `pnpm nuke` + `state clear` step
// that precedes a live-cloud suite run (see AGENTS.md, "The convergence
// loop"). Set `ALCHEMY_FLOCI_NO_RESET=1` to keep state across runs while
// iterating on a single suite.
if (!process.env.ALCHEMY_FLOCI_NO_RESET) {
  const endpoint =
    process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
  try {
    const res = await fetch(`${endpoint}/_floci/state/reset`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
    });
    console.log(
      res.ok
        ? `test:aws:floci: reset emulator state (${endpoint})`
        : `test:aws:floci: emulator state reset returned ${res.status}; continuing`,
    );
  } catch (error) {
    // Not fatal: the emulator may simply not be up yet, in which case
    // `ensureFloci` starts a fresh one during the run — which is clean anyway.
    console.log(
      `test:aws:floci: could not reset emulator state (${
        error instanceof Error ? error.message : String(error)
      }); continuing`,
    );
  }
}

const proc = Bun.spawn(["bun", "alchemy-test", ...files.sort(), ...flags], {
  cwd: alchemyRoot,
  // Bun.spawn's default env is a snapshot taken at process start, so the
  // `process.env.ALCHEMY_TEST_DEV` mutations above never reach the child
  // unless the env is materialized explicitly. Without this the "floci"
  // suite silently runs live against real AWS.
  env: { ...process.env },
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
});
process.exit(await proc.exited);
