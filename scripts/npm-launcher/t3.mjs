#!/usr/bin/env node
// Share the installer's runtime cache; pre-0.0.41 services re-enter here over IPC.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { version } = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "../package.json"), "utf8"),
);

const executableName = process.platform === "win32" ? "t3.exe" : "t3";

const SUPPORTED = ["darwin-arm64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"];

function t3Home() {
  const raw = (process.env.T3CODE_HOME || "").trim();
  if (raw === "") return path.join(os.homedir(), ".t3");
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

async function get(url) {
  const response = await fetch(url);
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
          `\r\x1b[2Kt3: downloading T3 Code ${version}${percent} (${(received / 1048576).toFixed(1)} MB)`,
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
  const archive = `t3-${version}-${key}.${process.platform === "win32" ? "zip" : "tar.gz"}`;
  const base = (
    process.env.T3CODE_RELEASE_BASE_URL || "https://github.com/pingdotgg/t3code/releases/download"
  ).replace(/\/+$/, "");
  const sums = await (await get(`${base}/v${version}/SHA256SUMS`)).text();
  const expected = /^([0-9a-f]{64})\s+\*?(.+)$/im;
  const line = sums
    .split(/\r?\n/)
    .map((l) => expected.exec(l.trim()))
    .find((m) => m && m[2] === archive);
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
    fs.writeFileSync(path.join(staging, ".install-complete"), `${version}\n`);
    publish(staging, dir);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

const isComplete = (dir, expected = version) => {
  try {
    return fs.readFileSync(path.join(dir, ".install-complete"), "utf8").trim() === expected;
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

/** Release order: numeric base, then a release above its prereleases, then prerelease fields. */
function compareVersions(left, right) {
  const parse = (value) => {
    const [base, pre = ""] = value.split("+")[0].split(/-(.*)/s);
    return { base: base.split(".").map(Number), pre: pre === "" ? [] : pre.split(".") };
  };
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i++) if (a.base[i] !== b.base[i]) return a.base[i] - b.base[i];
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const [x, y] = [a.pre[i], b.pre[i]];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const [xn, yn] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (xn && yn) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The newest `t3` installed in this home: launchers the install scripts and `t3 install` record,
 * plus the desktop app's launcher, which names its version in a comment.
 */
function newestInstalled(home) {
  const runtime = path.join(home, "runtime");
  const found = [];
  try {
    const versions = path.join(runtime, "versions");
    const base = process.platform === "win32" ? versions : fs.realpathSync(versions);
    for (const launcher of fs
      .readFileSync(path.join(runtime, "launchers"), "utf8")
      .split(/\r?\n/)) {
      try {
        const target =
          process.platform === "win32"
            ? // Only the exact shim T3 Code writes; a user's wrapper may set what t3 needs.
              /^@echo off\r?\n"([^"]+)" %\*\s*$/.exec(fs.readFileSync(launcher, "utf8"))?.[1]
            : fs.realpathSync(launcher);
        const relative = target ? path.relative(base, target) : "..";
        const installed = relative.split(path.sep)[0];
        if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
        // Only `<version>/t3`, never another executable inside a version.
        if (relative !== path.join(installed, executableName)) continue;
        if (!isComplete(path.join(versions, installed), installed)) continue;
        fs.accessSync(target, fs.constants.X_OK);
        // A Windows `t3.cmd` needs a shell; its target does not.
        found.push({
          version: installed,
          command: process.platform === "win32" ? target : launcher,
        });
      } catch {}
    }
  } catch {}
  if (process.platform !== "win32") {
    const shim = path.join(home, "bin", "t3");
    try {
      // The shim is a few hundred bytes; never read a large file someone else put there.
      const info = fs.statSync(shim);
      if (!info.isFile() || info.size > 16_384) throw new Error("not a desktop shim");
      const content = fs.readFileSync(shim, "utf8");
      const desktop = /^# T3 Code version: (\S+)$/m.exec(content)?.[1];
      // A moved or deleted app leaves the shim behind; it would only print an error.
      const app = /^app='(.*)'$/m.exec(content)?.[1]?.replaceAll(`'"'"'`, "'");
      if (desktop && app) {
        // Throws, skipping the shim, when either cannot run.
        for (const file of [app, shim]) fs.accessSync(file, fs.constants.X_OK);
        // The app refreshes the shim each launch. A replaced app gets a new ctime (even when
        // its mtime is kept), so a version line older than the app may name the wrong version.
        // A macOS bundle moved into place keeps its executable's ctime; only the bundle's changes.
        const bundle = /^(.*\.app)\/Contents\/MacOS\//.exec(app)?.[1];
        const changed = Math.max(
          fs.statSync(app).ctimeMs,
          bundle ? fs.statSync(bundle).ctimeMs : 0,
        );
        if (changed <= info.ctimeMs) {
          found.push({ version: desktop, command: shim });
        }
      }
    } catch {}
  }
  return found.sort((a, b) => compareVersions(b.version, a.version))[0];
}

/** The subcommand, past global flags that may come first; `--log-level` and `--completions` take a value. */
function topLevelCommand(args) {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--log-level" || args[index] === "--completions") index++;
    else if (!args[index].startsWith("-")) return args[index];
  }
}

function note(message) {
  if (process.stderr.isTTY) process.stderr.write(`t3: ${message}\n`);
}

async function main() {
  const home = t3Home();
  // Service IPC and signals must reach the child; terminal Ctrl-C already does, so do not forward SIGINT twice.
  const ipc = process.send !== undefined;
  // `install` links npm's copy itself; the desktop app's t3 cannot install itself.
  const installed =
    ipc ||
    process.env.T3CODE_USE_NPM === "1" ||
    topLevelCommand(process.argv.slice(2)) === "install"
      ? undefined
      : newestInstalled(home);
  if (installed && compareVersions(installed.version, version) >= 0) {
    note(
      `using your installed t3 ${installed.version} (${installed.command}). Set T3CODE_USE_NPM=1 for npm's ${version}.`,
    );
    const { T3CODE_NPM_LAUNCHER_PATH: _, ...env } = process.env;
    return run(installed.command, env, ipc, () => {
      note(`your installed t3 at ${installed.command} could not run, so npm's ${version} runs.`);
      runNpm(home, ipc).catch(fail);
    });
  }
  if (installed) {
    note(
      `your installed t3 ${installed.version} is older than ${version}, so npm's ${version} runs.`,
    );
  }
  await runNpm(home, ipc);
}

async function runNpm(home, ipc) {
  const key = `${process.platform}-${process.arch}`;
  if (!SUPPORTED.includes(key)) {
    throw new Error(
      `no T3 Code CLI build is available for ${key} (supported: ${SUPPORTED.join(", ")}).\n` +
        "The desktop app is at https://github.com/pingdotgg/t3code/releases",
    );
  }
  const dir = path.join(home, "runtime", "versions", version);
  if (!isComplete(dir)) await install(dir, key);
  // The executable lives in the T3 home, so this is how it knows npm launched it.
  run(
    path.join(dir, executableName),
    { ...process.env, T3CODE_NPM_LAUNCHER_PATH: import.meta.filename },
    ipc,
  );
}

/** `fallback` runs instead when the executable cannot start at all. */
function run(executable, env, ipc, fallback) {
  let child;
  try {
    child = spawn(executable, process.argv.slice(2), {
      stdio: ipc ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
      env,
    });
  } catch (error) {
    // Node throws some spawn errors (ETXTBSY) instead of emitting them.
    if (fallback) return fallback();
    throw error;
  }
  let done = false;
  const finish = (exit) => {
    if (done) return;
    done = true;
    exit();
  };
  if (ipc) {
    process.on("message", (message) => child.connected && child.send(message));
    child.on("message", (message) => process.connected && process.send(message));
    process.on("disconnect", () => child.connected && child.disconnect());
  }
  const forwards = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => {
    const forward = () => (ipc || signal !== "SIGINT") && child.kill(signal);
    process.on(signal, forward);
    return () => process.off(signal, forward);
  });
  // Stop forwarding to the dead child, so signals stop the launcher again while npm's copy downloads.
  const fallBack = () => {
    for (const stop of forwards) stop();
    fallback();
  };
  // After the child starts, an error comes from a failed kill or send; it is still running, and
  // its exit ends the launcher. Falling back then would run the command twice.
  let started = false;
  child.on("spawn", () => {
    started = true;
  });
  child.on("error", (error) => {
    if (!started) finish(() => (fallback ? fallBack() : fail(error)));
  });
  child.on("exit", (code, signal) =>
    finish(() =>
      // 126 and 127 mean the shell could not run it; t3 never exits with them (triage maps them).
      fallback && (code === 126 || code === 127)
        ? fallBack()
        : process.exit(code ?? 128 + (os.constants.signals[signal] || 1)),
    ),
  );
}

function fail(error) {
  process.stderr.write(`t3: ${error.message}\n`);
  process.exit(1);
}

await main().catch(fail);
