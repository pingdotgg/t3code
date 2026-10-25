// @effect-diagnostics nodeBuiltinImport:off globalConsole:off extendsNativeError:off - a maintainer script with only Node built-ins, like install-desktop.ts.
/**
 * `node scripts/fork/seed-sandbox-server.ts --run <run id> [--agent <name>]` unpacks a Fork release
 * run's server archive where packages/ssh/src/tunnel.ts keeps runtimes, so the app downloads
 * nothing. Without --agent it prints the version for T3CODE_REMOTE_SERVER_VERSION. Needs `gh` and
 * the `agentctl-<name>` alias. See docs/operations/fork-desktop-build.md.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const RELEASE_REPOSITORY = "martinothamar/t3code";

class SeedError extends Error {}

function fail(message: string): never {
  throw new SeedError(message);
}

/** The archive suffix for a host's `uname -s` and `uname -m`, as the SSH installer picks it. */
export function archiveTarget(system: string, machine: string): string | undefined {
  const platform = { Linux: "linux", Darwin: "darwin" }[system];
  const arch = { x86_64: "x64", amd64: "x64", aarch64: "arm64", arm64: "arm64" }[machine];
  return platform && arch ? `${platform}-${arch}` : undefined;
}

/** The version in a server archive's name, `t3-<version>-<platform>-<arch>.tar.gz`. */
export function archiveVersion(fileName: string, target: string): string | undefined {
  const suffix = `-${target}.tar.gz`;
  if (!fileName.startsWith("t3-") || !fileName.endsWith(suffix)) return undefined;
  const version = fileName.slice("t3-".length, -suffix.length);
  // It names a remote directory in a shell command.
  return /^[0-9A-Za-z.+-]+$/.test(version) ? version : undefined;
}

/** The version a Fork release run built, from its `release-meta` artifact. */
export function releaseMetaVersion(text: string): string | undefined {
  const version = /^version=(.+)$/m.exec(text)?.[1]?.trim();
  return version && /^[0-9A-Za-z.+-]+$/.test(version) ? version : undefined;
}

export interface SeedOptions {
  readonly run: string;
  readonly agent: string | undefined;
}

export function parseArguments(args: ReadonlyArray<string>): SeedOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag !== "--run" && flag !== "--agent") || value === undefined || value.startsWith("--")) {
      fail("Usage: node scripts/fork/seed-sandbox-server.ts --run <run id> [--agent <name>]");
    }
    values.set(flag, value);
    index++;
  }
  const run = values.get("--run");
  const agent = values.get("--agent");
  if (!run || !/^\d+$/.test(run)) fail("--run takes the id of a Fork release run.");
  return { run, agent };
}

/** Runs a command and returns its output, with the file at `inputPath` as its input if given. */
function run(command: string, args: ReadonlyArray<string>, inputPath?: string): string {
  const input = inputPath === undefined ? "ignore" : NodeFS.openSync(inputPath, "r");
  try {
    const result = NodeChildProcess.spawnSync(command, args, {
      encoding: "utf8",
      stdio: [input, "pipe", "inherit"],
    });
    if (result.error) fail(`${command} failed to start: ${result.error.message}`);
    if (result.status !== 0) fail(`${command} ${args.join(" ")} exited with ${result.status}.`);
    return result.stdout.trim();
  } finally {
    if (typeof input === "number") NodeFS.closeSync(input);
  }
}

// Unpacks the uploaded archive into the runtime directory the SSH installer reads, with the same
// checks it makes before marking a runtime installed.
const UNPACK_SCRIPT = `set -eu
version="$1"
versions="$HOME/.t3/runtime/versions"
archive="$versions/.seed-$version.tar.gz"
staging="$(mktemp -d "$versions/.staging-XXXXXX")"
trap 'rm -rf "$staging" "$archive"' EXIT
tar -xzf "$archive" -C "$staging" --strip-components=1
"$staging/t3" --version >/dev/null
printf '%s\\n' "$version" > "$staging/.install-complete"
rm -rf "$versions/$version"
mv "$staging" "$versions/$version"
trap - EXIT
rm -f "$archive"
`;

function download(runId: string, artifact: string, dir: string): void {
  run("gh", [
    "run",
    "download",
    runId,
    "--repo",
    RELEASE_REPOSITORY,
    "--name",
    artifact,
    "--dir",
    dir,
  ]);
}

function printVersion(runId: string): void {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-seed-"));
  try {
    download(runId, "release-meta", dir);
    const text = NodeFS.readFileSync(NodePath.join(dir, "release-meta.txt"), "utf8");
    console.log(releaseMetaVersion(text) ?? fail(`Run ${runId} records no version.`));
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

function main(): void {
  const options = parseArguments(process.argv.slice(2));
  if (options.agent === undefined) return printVersion(options.run);
  const host = `agentctl-${options.agent}`;
  const [system = "", machine = ""] = run("ssh", ["-o", "BatchMode=yes", host, "uname -sm"]).split(
    /\s+/,
  );
  const target =
    archiveTarget(system, machine) ?? fail(`No server archive for ${system} ${machine}.`);

  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-seed-"));
  try {
    console.log(`Downloading the ${target} server from run ${options.run}…`);
    download(options.run, `cli-${target}`, dir);
    const archive = NodeFS.readdirSync(dir).find((name) => archiveVersion(name, target));
    if (!archive) fail(`Run ${options.run} has no ${target} server archive.`);
    const version = archiveVersion(archive, target) ?? fail(`Unexpected archive ${archive}.`);

    console.log(`Installing t3 ${version} in ${options.agent}…`);
    run(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        host,
        `mkdir -p ~/.t3/runtime/versions && cat > ~/.t3/runtime/versions/.seed-${version}.tar.gz`,
      ],
      NodePath.join(dir, archive),
    );
    const script = NodePath.join(dir, "unpack.sh");
    NodeFS.writeFileSync(script, UNPACK_SCRIPT);
    run("ssh", ["-o", "BatchMode=yes", host, "sh", "-s", "--", version], script);
    console.log(`Installed. Start the app with T3CODE_REMOTE_SERVER_VERSION=${version}.`);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    if (!(error instanceof SeedError)) throw error;
    console.error(`[seed-sandbox-server] ${error.message}`);
    process.exit(1);
  }
}
