// @effect-diagnostics nodeBuiltinImport:off - the executed suite runs the generated install script through a real POSIX shell.
import { describe, it } from "@effect/vitest";
import { afterAll, expect } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";

import {
  buildWslRuntimeInstallScript,
  buildWslRuntimeInvalidateScript,
  buildWslRuntimePruneScript,
  buildWslRuntimeProbeScript,
  parseResolvedPath,
  parseWslRuntimeRoot,
} from "./DesktopWslEnvironment.ts";

// The install script only fails the way this file cares about when a real shell
// runs it, so find one that has the tools it needs: bash directly on Linux, and
// the WSL distro on a Windows dev box, where Git Bash ships no flock. Anywhere
// else the executed suite skips and the generated-text assertions stand alone.
const REQUIRED_SHELL_TOOLS = ["flock", "sha256sum", "tar", "mktemp"] as const;

const posixShellRunner = (() => {
  const candidates = [
    { file: "bash", args: [] as ReadonlyArray<string> },
    { file: "wsl.exe", args: ["-e", "bash"] as ReadonlyArray<string> },
  ];
  const probe = [
    "[ -d /proc/1 ] || exit 1",
    ...REQUIRED_SHELL_TOOLS.map((tool) => `command -v ${tool} >/dev/null || exit 1`),
  ].join("\n");
  return (
    candidates.find((candidate) => {
      const result = NodeChildProcess.spawnSync(candidate.file, [...candidate.args, "-c", probe], {
        encoding: "utf8",
      });
      return result.status === 0;
    }) ?? null
  );
})();

const runShell = (script: string) => {
  if (posixShellRunner === null) throw new Error("no POSIX shell runner available");
  // Pass the script on stdin, as production does, to avoid matching its own /proc scan.
  const result = NodeChildProcess.spawnSync(
    posixShellRunner.file,
    [...posixShellRunner.args, "-s"],
    { input: script, encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

const sh = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const awaitHolder = (condition: string) =>
  `i=0; until ${condition}; do i=$((i + 1)); [ "$i" -lt 500 ] || exit 1; sleep 0.01; done`;

// Use runtime-entry argv[0] for /proc detection; an open pipe keeps it alive only while this script runs.
const holdRuntimeBusy = (entry: string) =>
  [
    `exec 7> >(exec -a ${entry} cat >/dev/null 2>&1)`,
    awaitHolder(`grep -qF -- ${entry} /proc/[0-9]*/cmdline 2>/dev/null`),
  ].join("\n");

const holdInstallLock = (lock: string) =>
  [
    `exec 6> >(exec 9> ${lock}; flock -x 9; cat >/dev/null 2>&1)`,
    awaitHolder(`! flock -n ${lock} true`),
  ].join("\n");

const readField = (stdout: string, field: string) => {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(`${field}:`));
  if (line === undefined) throw new Error(`missing ${field} in fixture output: ${stdout}`);
  return line.slice(field.length + 1).trim();
};

const SERVER_ENTRY_SOURCE = '#!/bin/sh\necho "t3code wsl runtime test server 0.0.0"\n';

describe("WSL runtime cache", () => {
  it.each([
    [
      "install",
      (id: string) => buildWslRuntimeInstallScript("/runtime.tar.gz", id, "b".repeat(64)),
    ],
    ["prune", buildWslRuntimePruneScript],
    ["invalidate", buildWslRuntimeInvalidateScript],
  ] as const)("sanitizes cache ids in the %s script", (_, buildScript) => {
    const runtimeId = "1.2.3/x64; touch /tmp/nope";
    const script = buildScript(runtimeId);
    expect(script).toContain("/1.2.3_x64__touch__tmp_nope");
    expect(script).not.toContain(runtimeId);
  });
});

describe.skipIf(posixShellRunner === null)("WSL runtime install script (executed)", () => {
  const fixtures: Array<string> = [];

  afterAll(() => {
    for (const work of fixtures) runShell(`set -eu\nrm -rf ${sh(work)}`);
    fixtures.length = 0;
  });

  const createFixture = (serverEntry = SERVER_ENTRY_SOURCE) => {
    const result = runShell(
      [
        "set -eu",
        "work=$(mktemp -d)",
        'stage="$work/stage/t3-0.0.0-linux-x64"',
        'mkdir -p "$stage/node_modules/node-pty/build/Release" "$work/home"',
        `printf '%s' ${sh(serverEntry)} > "$stage/t3"`,
        'chmod +x "$stage/t3"',
        `printf '%s' 'pty-native-payload' > "$stage/node_modules/node-pty/build/Release/pty.node"`,
        `tar -czf "$work/wsl-runtime.tar.gz" -C "$work/stage" t3-0.0.0-linux-x64`,
        `printf 'work:%s\\n' "$work"`,
        `printf 'archiveSha:%s\\n' "$(sha256sum "$work/wsl-runtime.tar.gz" | cut -d ' ' -f 1)"`,
      ].join("\n"),
    );
    expect(result.status, result.stderr).toBe(0);

    const work = readField(result.stdout, "work");
    fixtures.push(work);
    const archivePath = `${work}/wsl-runtime.tar.gz`;
    const archiveSha = readField(result.stdout, "archiveSha");
    const runtimeId = `sha256-${archiveSha}`;
    // WSL does not inherit HOME; embed the fixture's override in the script.
    const installScript = (archive = archivePath, sha = archiveSha) =>
      [
        `HOME=${sh(`${work}/home`)}`,
        "export HOME",
        buildWslRuntimeInstallScript(archive, runtimeId, sha),
      ].join("\n");
    return {
      work,
      archivePath,
      archiveSha,
      runtimeId,
      runtimeParent: `${work}/home/.t3/wsl-runtime`,
      runtimeRoot: `${work}/home/.t3/wsl-runtime/${runtimeId}`,
      serverEntry: `${work}/home/.t3/wsl-runtime/${runtimeId}/t3`,
      installScript,
      install: (archive?: string, sha?: string) => runShell(installScript(archive, sha)),
    };
  };

  const probeFixture = (fixture: ReturnType<typeof createFixture>) =>
    runShell(
      [
        `export HOME=${sh(`${fixture.work}/home`)}`,
        'export NVM_DIR="$HOME/.nvm" FNM_DIR="$HOME/.fnm" VOLTA_HOME="$HOME/.volta"',
        "bash() { (",
        "  command() {",
        '    case "$*" in',
        '      "-v node"|"-v mise"|"-v fnm"|"-v nodenv") return 1 ;;',
        '      *) builtin command "$@" ;;',
        "    esac",
        "  }",
        '  eval "$2"',
        "); }",
        buildWslRuntimeProbeScript(fixture.runtimeRoot),
      ].join("\n"),
    );

  it("discovers version-managed Node for providers with a standalone runtime", () => {
    const fixture = createFixture();
    expect(fixture.install().status).toBe(0);
    const nodeBin = `${fixture.work}/home/.nvm/versions/node/v24.15.0/bin`;
    const setup = runShell(
      [
        "set -eu",
        `mkdir -p ${sh(nodeBin)}`,
        `printf '%s' ${sh('#!/bin/sh\nprintf "linux-node-provider\\n"\n')} > ${sh(`${nodeBin}/node`)}`,
        `chmod +x ${sh(`${nodeBin}/node`)}`,
      ].join("\n"),
    );
    expect(setup.status, setup.stderr).toBe(0);

    const probe = probeFixture(fixture);

    expect(probe.status, probe.stderr).toBe(0);
    const resolvedPath = parseResolvedPath(probe.stdout);
    expect(resolvedPath?.split(":")).toContain(nodeBin);
    const provider = runShell(`export PATH=${sh(resolvedPath ?? "")}\nnode provider.js`);
    expect(provider.status, provider.stderr).toBe(0);
    expect(provider.stdout).toBe("linux-node-provider\n");
  });

  it("keeps the inherited PATH when bash is unavailable", () => {
    const fixture = createFixture();
    expect(fixture.install().status).toBe(0);
    const probe = runShell(
      [
        "bash() { return 127; }",
        'export PATH="/fixture/bin:/usr/bin:/bin"',
        buildWslRuntimeProbeScript(fixture.runtimeRoot),
      ].join("\n"),
    );

    expect(probe.status, probe.stderr).toBe(0);
    expect(parseResolvedPath(probe.stdout)).toBe("/fixture/bin:/usr/bin:/bin");
  });

  it("reuses a warm cache without touching the archive", () => {
    const fixture = createFixture();
    expect(fixture.install().status).toBe(0);
    expect(runShell(`set -eu\nrm ${sh(fixture.archivePath)}`).status).toBe(0);

    const warm = fixture.install();

    expect(warm.status, warm.stderr).toBe(0);
    expect(parseWslRuntimeRoot(warm.stdout)).toBe(fixture.runtimeRoot);
  });

  it("retains the loader error when a bundled executable needs a missing system library", () => {
    const fixture = createFixture(
      '#!/bin/sh\nprintf "error while loading shared libraries: libatomic.so.1: cannot open shared object file\\n" >&2\nexit 127\n',
    );

    const result = fixture.install();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("libatomic.so.1");
    expect(parseWslRuntimeRoot(result.stdout)).toBeNull();
  });

  it("reinstalls a cache whose executable was truncated", () => {
    const fixture = createFixture();
    expect(fixture.install().status).toBe(0);
    expect(runShell(`set -eu\n: > ${sh(fixture.serverEntry)}`).status).toBe(0);

    const repaired = fixture.install();

    expect(repaired.status, repaired.stderr).toBe(0);
    expect(parseWslRuntimeRoot(repaired.stdout)).toBe(fixture.runtimeRoot);
    const restored = runShell(`set -eu\ncat ${sh(fixture.serverEntry)}`);
    expect(restored.stdout).toBe(SERVER_ENTRY_SOURCE);
  });

  it("reinstalls an executable that fails --version despite a matching recorded digest", () => {
    const fixture = createFixture();
    expect(fixture.install().status).toBe(0);
    const brokenEntry = "#!/bin/sh\nexit 42\n";
    const corrupt = runShell(
      [
        "set -eu",
        `printf '%s' ${sh(brokenEntry)} > ${sh(fixture.serverEntry)}`,
        `chmod +x ${sh(fixture.serverEntry)}`,
        `sha256sum ${sh(fixture.serverEntry)} | cut -d ' ' -f 1 > ${sh(`${fixture.runtimeRoot}/.t3code-wsl-runtime-ready`)}`,
      ].join("\n"),
    );
    expect(corrupt.status, corrupt.stderr).toBe(0);
    expect(runShell(`${sh(fixture.serverEntry)} --version`).status).toBe(42);

    const repaired = fixture.install();
    expect(repaired.status, repaired.stderr).toBe(0);
    expect(parseWslRuntimeRoot(repaired.stdout)).toBe(fixture.runtimeRoot);
    expect(runShell(`cat ${sh(fixture.serverEntry)}`).stdout).toBe(SERVER_ENTRY_SOURCE);
    expect(runShell(`${sh(fixture.serverEntry)} --version`).status).toBe(0);
  });

  it("falls back instead of launching a corrupted cache it cannot reinstall", () => {
    const fixture = createFixture();
    expect(fixture.install().status).toBe(0);
    expect(runShell(`set -eu\n: > ${sh(fixture.serverEntry)}`).status).toBe(0);
    expect(runShell(`set -eu\nrm ${sh(fixture.archivePath)}`).status).toBe(0);

    const broken = fixture.install();

    expect(broken.status).not.toBe(0);
    expect(parseWslRuntimeRoot(broken.stdout)).toBeNull();
  });

  it("extracts once when two installs race for the same cache", () => {
    const fixture = createFixture();
    const raced = runShell(
      [
        "set -eu",
        `work=${sh(fixture.work)}`,
        'mkdir -p "$work/bin"',
        "real_tar=$(command -v tar)",
        `printf '#!/bin/sh\\nprintf x >> "%s/tar-calls"\\nsleep 1\\nexec %s "$@"\\n' "$work" "$real_tar" > "$work/bin/tar"`,
        'chmod +x "$work/bin/tar"',
        ': > "$work/tar-calls"',
        'PATH="$work/bin:$PATH"',
        "export PATH",
        `cat > "$work/install.sh" <<'T3CODE_INSTALL_SCRIPT'`,
        fixture.installScript(),
        "T3CODE_INSTALL_SCRIPT",
        // Keep runtime roots out of both racers' argv so their /proc scans cannot match themselves.
        'sh "$work/install.sh" > "$work/first.out" 2>&1 &',
        "first=$!",
        'sh "$work/install.sh" > "$work/second.out" 2>&1 &',
        "second=$!",
        "if wait $first; then first_status=0; else first_status=$?; fi",
        "if wait $second; then second_status=0; else second_status=$?; fi",
        `printf 'firstStatus:%s\\n' "$first_status"`,
        `printf 'secondStatus:%s\\n' "$second_status"`,
        `printf 'extractions:%s\\n' "$(wc -c < "$work/tar-calls" | tr -d ' ')"`,
        `printf 'firstRoot:%s\\n' "$(sed -n 's/^runtimeRoot://p' "$work/first.out")"`,
        `printf 'secondRoot:%s\\n' "$(sed -n 's/^runtimeRoot://p' "$work/second.out")"`,
      ].join("\n"),
    );

    expect(raced.status, raced.stderr).toBe(0);
    expect(readField(raced.stdout, "firstStatus")).toBe("0");
    expect(readField(raced.stdout, "secondStatus")).toBe("0");
    expect(readField(raced.stdout, "extractions")).toBe("1");
    expect(readField(raced.stdout, "firstRoot")).toBe(fixture.runtimeRoot);
    expect(readField(raced.stdout, "secondRoot")).toBe(fixture.runtimeRoot);
  });

  it("leaves no half-built cache when extraction fails", () => {
    const fixture = createFixture();
    const truncated = runShell(
      [
        "set -eu",
        `work=${sh(fixture.work)}`,
        'size=$(wc -c < "$work/wsl-runtime.tar.gz")',
        'head -c $((size / 2)) "$work/wsl-runtime.tar.gz" > "$work/truncated.tar.gz"',
        `printf 'sha:%s\\n' "$(sha256sum "$work/truncated.tar.gz" | cut -d ' ' -f 1)"`,
      ].join("\n"),
    );
    expect(truncated.status, truncated.stderr).toBe(0);

    const failed = fixture.install(
      `${fixture.work}/truncated.tar.gz`,
      readField(truncated.stdout, "sha"),
    );

    expect(failed.status).not.toBe(0);
    expect(parseWslRuntimeRoot(failed.stdout)).toBeNull();
    const leftovers = runShell(
      `set -eu\nfind ${sh(fixture.runtimeParent)} -mindepth 1 -maxdepth 1 -type d`,
    );
    expect(leftovers.stdout.trim()).toBe("");
  });

  it("refuses an archive whose bytes do not match the digest recorded for it", () => {
    const fixture = createFixture();

    const refused = fixture.install(fixture.archivePath, "e".repeat(64));

    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("does not match its recorded SHA-256");
    expect(parseWslRuntimeRoot(refused.stdout)).toBeNull();
    const leftovers = runShell(
      `set -eu\nfind ${sh(fixture.runtimeParent)} -mindepth 1 -maxdepth 1 -type d`,
    );
    expect(leftovers.stdout.trim()).toBe("");
  });

  it("leases a warm cache across the prepare-to-spawn handoff", () => {
    const fixture = createFixture();
    expect(fixture.install().status).toBe(0);
    const selected = runShell(
      [
        "set -eu",
        `runtime_parent=${sh(fixture.runtimeParent)}`,
        'mkdir -p "$runtime_parent/sha256-current" "$runtime_parent/sha256-previous"',
        'printf ready > "$runtime_parent/sha256-current/.t3code-wsl-runtime-ready"',
        'printf ready > "$runtime_parent/sha256-previous/.t3code-wsl-runtime-ready"',
        `touch -d "10 minutes ago" ${sh(fixture.runtimeRoot)}`,
        'touch -d "1 minute ago" "$runtime_parent/sha256-previous"',
        `cat > ${sh(`${fixture.work}/select.sh`)} <<'T3CODE_SELECT_SCRIPT'`,
        fixture.installScript(),
        "T3CODE_SELECT_SCRIPT",
        `sh ${sh(`${fixture.work}/select.sh`)}`,
        `HOME=${sh(`${fixture.work}/home`)}`,
        "export HOME",
        buildWslRuntimePruneScript("sha256-current"),
        `test -d ${sh(fixture.runtimeRoot)}`,
      ].join("\n"),
    );

    expect(selected.status, `${selected.stdout}\n${selected.stderr}`).toBe(0);
  });

  it("prunes old and markerless caches without touching retained, active, locked, or unrelated roots", () => {
    const result = runShell(
      [
        "set -eu",
        "work=$(mktemp -d)",
        'home="$work/home"',
        'runtime_parent="$home/.t3/wsl-runtime"',
        'mkdir -p "$runtime_parent"',
        'make_ready() { mkdir -p "$runtime_parent/$1"; printf ready > "$runtime_parent/$1/.t3code-wsl-runtime-ready"; }',
        "make_ready sha256-current",
        "make_ready sha256-previous",
        "make_ready sha256-active",
        "make_ready sha256-old",
        "make_ready sha256-locked",
        'mkdir -p "$runtime_parent/sha256-markerless" "$runtime_parent/versions"',
        'touch -d "1 minute ago" "$runtime_parent/sha256-previous"',
        'touch -d "4 minutes ago" "$runtime_parent/sha256-active"',
        'touch -d "3 minutes ago" "$runtime_parent/sha256-old"',
        'touch -d "2 minutes ago" "$runtime_parent/sha256-locked"',
        holdRuntimeBusy('"$runtime_parent/sha256-active/t3"'),
        holdInstallLock('"$runtime_parent/.sha256-locked.install.lock"'),
        `HOME="$home"`,
        "export HOME",
        buildWslRuntimePruneScript("sha256-current"),
        'test -d "$runtime_parent/sha256-current"',
        'test -d "$runtime_parent/sha256-previous"',
        'test -d "$runtime_parent/sha256-active"',
        'test -d "$runtime_parent/sha256-locked"',
        'test -d "$runtime_parent/versions"',
        'test ! -e "$runtime_parent/sha256-old"',
        'test ! -e "$runtime_parent/sha256-markerless"',
        'rm -rf "$work"',
      ].join("\n"),
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});

describe("parseResolvedPath", () => {
  it("preserves spaces and apostrophes in the resolved login-shell PATH", () => {
    const resolvedPath = "/home/test user/bin:/opt/test's tools/bin:/usr/bin:/bin";
    expect(parseResolvedPath(`nodePath:/usr/bin/node\nresolvedPath:${resolvedPath}\n`)).toBe(
      resolvedPath,
    );
  });

  it("accepts CRLF output without retaining the carriage return", () => {
    expect(parseResolvedPath("resolvedPath:/usr/local/bin:/usr/bin\r\n")).toBe(
      "/usr/local/bin:/usr/bin",
    );
  });
});
