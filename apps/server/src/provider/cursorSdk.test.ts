// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "vite-plus/test";

const cursorSdkUrl = new URL("./cursorSdk.ts", import.meta.url).href;

// Loads cursorSdk.ts in a fresh process. @cursor/sdk is stubbed so the guard
// can be tested without the real package. The vitest worker already has its
// own unhandledRejection listener, which would hide the process-exit behavior.
const probeProgram = `
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "cursor-sdk-stub-"));
const stub = join(dir, "stub.cjs");
writeFileSync(
  stub,
  "module.exports = { Agent: {}, AuthenticationError: class {}, createAgentPlatform: () => ({}), Cursor: {}, CursorSdkError: class {}, InMemoryCredentialStore: class {} };",
);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@cursor/sdk") {
      return { url: pathToFileURL(stub).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { isCursorShellSpawnFailure } = await import(${JSON.stringify(cursorSdkUrl)});
const mode = process.argv[1];
const missingCwd = join(tmpdir(), "t3-missing-cwd-" + process.pid);

if (mode === "predicate") {
  const cursorShell = Object.assign(new Error("spawn /bin/zsh ENOENT"), {
    code: "ENOENT",
    syscall: "spawn /bin/zsh",
    path: "/bin/zsh",
    spawnargs: ["-c", "dump_zsh_state >&4", "--", "true"],
  });
  const bashShell = Object.assign(new Error("spawn bash ENOENT"), {
    code: "ENOENT",
    syscall: "spawn bash",
    spawnargs: ["-c", "dump_bash_state >&4"],
  });
  const sandboxRestore = Object.assign(new Error("spawn /bin/zsh ENOENT"), {
    code: "ENOENT",
    syscall: "spawn /bin/zsh",
    spawnargs: ["-c", "builtin eval \\"\${__CURSOR_SANDBOX_ENV_RESTORE:-}\\""],
  });
  const gitSpawn = Object.assign(new Error("spawn git ENOENT"), {
    code: "ENOENT",
    syscall: "spawn git",
    path: "git",
    spawnargs: ["status"],
  });
  const plainZsh = Object.assign(new Error("spawn /bin/zsh ENOENT"), {
    code: "ENOENT",
    syscall: "spawn /bin/zsh",
    path: "/bin/zsh",
    spawnargs: ["-lc", "true"],
  });
  console.log(
    JSON.stringify({
      cursorShell: isCursorShellSpawnFailure(cursorShell),
      bashShell: isCursorShellSpawnFailure(bashShell),
      sandboxRestore: isCursorShellSpawnFailure(sandboxRestore),
      gitSpawn: isCursorShellSpawnFailure(gitSpawn),
      plainZsh: isCursorShellSpawnFailure(plainZsh),
      open: isCursorShellSpawnFailure(
        Object.assign(new Error("open failed"), { code: "ENOENT", syscall: "open" }),
      ),
      plain: isCursorShellSpawnFailure(new Error("boom")),
      string: isCursorShellSpawnFailure("spawn ENOENT"),
    }),
  );
  process.exit(0);
}

if (mode === "cursor-shell") {
  const child = spawn("/bin/zsh", ["-c", "dump_zsh_state >&4", "--", "true"], {
    cwd: missingCwd,
  });
  child.on("error", (error) => {
    Promise.reject(error);
  });
  setTimeout(() => process.exit(0), 500);
} else if (mode === "other-spawn") {
  Promise.reject(
    Object.assign(new Error("spawn git ENOENT"), {
      code: "ENOENT",
      syscall: "spawn git",
      path: "git",
      spawnargs: ["status"],
    }),
  );
  setTimeout(() => process.exit(0), 500);
} else if (mode === "other-rejection") {
  Promise.reject(new Error("boom"));
  setTimeout(() => process.exit(0), 500);
} else if (mode === "spawn-without-listener") {
  spawn(process.execPath, ["-e", "process.exit(0)"], { cwd: missingCwd });
  setTimeout(() => process.exit(0), 500);
} else {
  console.error("Unknown cursor shell spawn guard probe: " + mode);
  process.exit(2);
}
`;

function runProbe(mode: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "-e",
        probeProgram,
        mode,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`probe ${mode} timed out`));
    }, 5_000);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("isCursorShellSpawnFailure", () => {
  it("matches only Cursor's shell wrapper", async () => {
    const result = await runProbe("predicate");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      cursorShell: true,
      bashShell: true,
      sandboxRestore: true,
      gitSpawn: false,
      plainZsh: false,
      open: false,
      plain: false,
      string: false,
    });
  });
});

describe("Cursor shell spawn guard", () => {
  it("keeps the process alive when Cursor's shell spawn rejects", async () => {
    const result = await runProbe("cursor-shell");
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("The server will keep running.");
    expect(result.stderr).toContain("ENOENT");
  });

  it("still exits when a different spawn failure is unhandled", async () => {
    const result = await runProbe("other-spawn");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("spawn git ENOENT");
    expect(result.stderr).not.toContain("The server will keep running.");
  });

  it("still exits on unrelated unhandled rejections", async () => {
    const result = await runProbe("other-rejection");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("boom");
  });

  it("leaves a spawn with no error listener fatal", async () => {
    const result = await runProbe("spawn-without-listener");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unhandled");
    expect(result.stderr).not.toContain("The server will keep running.");
  });
});
