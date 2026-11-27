#!/usr/bin/env node
// Share the installer's runtime cache; pre-0.0.41 services re-enter here over IPC.
//
// Fork: this script runs as published, so it cannot import FORK_IDENTITY. Its fork values
// (release repository, `.lathe` home with the `.t3f` fallback, `lathe-`/`t3-` names) mirror
// forkIdentity.ts, forkBaseDir.ts and forkCliArtifacts.ts; build-npm-launcher.test.ts checks them.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { version } = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "../package.json"), "utf8"),
);

// Fork: the fork's release builds no Windows CLI archives.
const SUPPORTED = ["darwin-arm64", "linux-arm64", "linux-x64"];
// Well inside launchd's 20 s ExitTimeOut, which SIGKILLs only the launcher and orphans the runtime.
const TERMINATE_GRACE_MS = 5_000;

// Fork: the executable and archive names, Lathe first (forkCliArtifacts.ts).
const CLI_NAMES = ["lathe", "t3"];
const executableName = (name) => (process.platform === "win32" ? `${name}.exe` : name);

// Fork: `<dir>/lathe`, or `<dir>/t3` in a runtime unpacked before the rename.
const runtimeExecutable = (dir) =>
  CLI_NAMES.map((name) => path.join(dir, executableName(name))).find((file) =>
    fs.existsSync(file),
  ) ?? path.join(dir, executableName(CLI_NAMES[0]));

/** Fork: `.lathe`, or a pre-rename `.t3f` while it is the one in use (forkBaseDir.ts). */
function defaultHome() {
  const lathe = path.join(os.homedir(), ".lathe");
  const legacy = path.join(os.homedir(), ".t3f");
  return !fs.existsSync(lathe) && fs.existsSync(legacy) ? legacy : lathe;
}

function latheHome() {
  const raw = (process.env.LATHE_HOME || "").trim();
  if (raw === "") return defaultHome();
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

const isTransient = (status) => status === 408 || status === 429 || status >= 500;

async function get(url) {
  let response;
  for (let attempt = 1; ; attempt++) {
    try {
      response = await fetch(url);
      if (attempt === 4 || !isTransient(response.status)) break;
      await response.body?.cancel();
    } catch (error) {
      if (attempt === 4) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
  }
  if (response.status === 404) {
    throw new Error(
      `${url} does not exist yet. If ${version} was just released, try again in a few minutes.`,
    );
  }
  if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`);
  return response;
}

async function download(url, file) {
  const response = await get(url);
  const total = Number(response.headers.get("content-length")) || 0;
  const hash = crypto.createHash("sha256");
  const out = fs.openSync(file, "w");
  const tty = process.stderr.isTTY;
  let received = 0;
  let shown = -1;
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      fs.writeSync(out, chunk);
      received += chunk.byteLength;
      // Redraw once per percent (or per MB without a length), not per chunk.
      const step = total ? Math.floor((received * 100) / total) : Math.floor(received / 1048576);
      if (tty && step !== shown) {
        shown = step;
        const percent = total ? ` ${step}%` : "";
        process.stderr.write(
          `\r\x1b[2Klathe: downloading Lathe ${version}${percent} (${(received / 1048576).toFixed(1)} MB)`,
        );
      }
    }
  } finally {
    fs.closeSync(out);
    if (tty) process.stderr.write("\r\x1b[2K");
  }
  return hash.digest("hex");
}

async function install(dir, key) {
  const suffix = `${version}-${key}.${process.platform === "win32" ? "zip" : "tar.gz"}`;
  const base = (
    process.env.LATHE_RELEASE_BASE_URL || "https://github.com/latheworks/t3code/releases/download"
  ).replace(/\/+$/, "");
  const sums = await (await get(`${base}/v${version}/SHA256SUMS`)).text();
  const expected = /^([0-9a-f]{64})\s+\*?(.+)$/im;
  const listed = sums.split(/\r?\n/).map((l) => expected.exec(l.trim()));
  // Fork: a release after the Lathe rename lists `lathe-*`, one before it only `t3-*`.
  const archive =
    CLI_NAMES.map((name) => `${name}-${suffix}`).find((name) =>
      listed.some((m) => m && m[2] === name),
    ) ?? `${CLI_NAMES[0]}-${suffix}`;
  const line = listed.find((m) => m && m[2] === archive);
  if (!line) throw new Error(`${archive} is not listed in the release's SHA256SUMS`);

  // Stage beside the destination and rename atomically to avoid half-installed versions.
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const staging = fs.mkdtempSync(`${dir}.staging-`);
  try {
    const file = path.join(staging, archive);
    if ((await download(`${base}/v${version}/${archive}`, file)) !== line[1].toLowerCase()) {
      throw new Error(`checksum mismatch for ${archive}`);
    }
    // Windows' own tar.exe reads zip; a Git-for-Windows tar on PATH cannot.
    const tar =
      process.platform === "win32" ? `${process.env.SystemRoot}\\System32\\tar.exe` : "tar";
    const extract = spawnSync(tar, ["-xf", file, "-C", staging, "--strip-components=1"], {
      stdio: "inherit",
    });
    if (extract.status !== 0) throw new Error(`could not extract ${archive}`);
    fs.rmSync(file);
    const probe = (file, args) =>
      spawnSync(file, [...args, "--version"], {
        stdio: ["ignore", "ignore", "pipe"],
        encoding: "utf8",
        timeout: 30_000,
        killSignal: "SIGKILL",
      });
    let validate = probe(runtimeExecutable(staging), []);
    // Fork: where the executable cannot load (NixOS, musl), check the bundle main() falls back to.
    const bundle = path.join(staging, "bin.mjs");
    if (["ENOENT", "EACCES"].includes(validate.error?.code) && fs.existsSync(bundle)) {
      validate = probe(process.execPath, [bundle]);
    }
    if (validate.status !== 0) {
      throw executableError(
        key,
        validate.error?.message ||
          validate.stderr?.trim() ||
          `--version exited with ${validate.signal || validate.status}`,
      );
    }
    fs.writeFileSync(path.join(staging, ".install-complete"), `${version}\n`);
    publish(staging, dir);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

const isComplete = (dir) => {
  try {
    return fs.readFileSync(path.join(dir, ".install-complete"), "utf8").trim() === version;
  } catch {
    return false;
  }
};

/** Preserve concurrently published complete installs; replace only incomplete folders without the completion marker. */
function publish(staging, dir) {
  try {
    fs.renameSync(staging, dir);
    return;
  } catch (error) {
    if (isComplete(dir)) return;
    if (!fs.existsSync(dir)) throw error;
  }
  const lock = `${dir}.lock`;
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(
      `another t3 is installing ${version}. If none is running, delete ${lock} and try again.`,
      { cause: error },
    );
  }
  const stale = `${staging}.stale`;
  try {
    // A peer may have published between our marker check and taking the lock.
    if (isComplete(dir)) return;
    // Move it aside rather than deleting in place: once the folder is empty, a
    // peer's first rename can land in it.
    fs.renameSync(dir, stale);
    try {
      fs.renameSync(staging, dir);
    } catch (error) {
      if (!isComplete(dir)) throw error;
    }
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
    fs.rmSync(stale, { recursive: true, force: true });
  }
}

async function main() {
  const key = `${process.platform}-${process.arch}`;
  if (!SUPPORTED.includes(key)) {
    throw new Error(
      `no Lathe CLI build is available for ${key} (supported: ${SUPPORTED.join(", ")}).\n` +
        "The desktop app is at https://github.com/latheworks/t3code/releases",
    );
  }
  const dir = path.join(latheHome(), "runtime", "versions", version);
  if (!isComplete(dir)) await install(dir, key);

  // Service IPC and signals must reach the child; terminal Ctrl-C already does, so do not forward SIGINT twice.
  const ipc = process.send !== undefined;
  const args = process.argv.slice(2);
  let child;
  const start = (file, fileArgs) => {
    child = spawn(file, fileArgs, {
      stdio: ipc ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
      // The executable lives in the Lathe home, so this is how it knows npm launched it.
      env: { ...process.env, LATHE_NPM_LAUNCHER_PATH: import.meta.filename },
    });
    if (ipc) child.on("message", (message) => process.connected && process.send(message));
    child.on("error", (error) => {
      // Fork: a host whose libc cannot load the executable (NixOS, musl)
      // fails exec with ENOENT or EACCES. This launcher already runs under a
      // Node that can run the archive's server bundle as a script, so use it.
      const bundle = path.join(dir, "bin.mjs");
      if (
        file !== process.execPath &&
        ["ENOENT", "EACCES"].includes(error.code) &&
        fs.existsSync(bundle)
      ) {
        start(process.execPath, [bundle, ...args]);
        return;
      }
      fail(executableError(key, error.message));
    });
    child.on("exit", (code, signal) =>
      process.exit(code ?? 128 + (os.constants.signals[signal] || 1)),
    );
  };
  start(runtimeExecutable(dir), args);
  if (ipc) {
    process.on("message", (message) => child.connected && child.send(message));
    process.on("disconnect", () => child.connected && child.disconnect());
  }
  let force;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      if (!ipc && signal === "SIGINT") return;
      child.kill(signal);
      force ??= setTimeout(() => killTree(child), TERMINATE_GRACE_MS).unref();
    });
  }
}

/** SIGKILL the runtime and its providers, which a runtime stuck on shutdown never stops. */
function killTree(child) {
  const pids = [child.pid];
  if (process.platform !== "win32") {
    const table =
      spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 2_000 }).stdout ||
      "";
    const rows = table
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number));
    for (let i = 0; i < pids.length; i++) {
      for (const [pid, ppid] of rows) if (ppid === pids[i]) pids.push(pid);
    }
  }
  for (const pid of pids.slice(1)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  child.kill("SIGKILL");
}

function executableError(key, detail) {
  return new Error(
    `could not run Lathe ${version} for ${key}: ${detail}` +
      (process.platform === "linux"
        ? "\nThe Linux release requires glibc; musl-based systems such as Alpine are not supported. Use a glibc-based Linux environment."
        : ""),
  );
}

function fail(error) {
  process.stderr.write(`lathe: ${error.message}\n`);
  process.exit(1);
}

await main().catch(fail);
