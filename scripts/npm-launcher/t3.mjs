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

// Current CLI archives fit within 128 MiB. A larger release needs an explicit
// limit change; extraction and other installer writes are separate costs.
const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;

const SUPPORTED = ["darwin-arm64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"];

function t3Home() {
  const raw = (process.env.T3CODE_HOME || "").trim();
  if (raw === "") return path.join(os.homedir(), ".t3");
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

async function get(url, options) {
  const response = await fetch(url, options);
  if (response.status === 404) {
    throw new Error(
      `${url} does not exist yet. If ${version} was just released, try again in a few minutes.`,
    );
  }
  if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`);
  return response;
}

async function download(url, file) {
  const controller = new AbortController();
  const tty = process.stderr.isTTY;
  let out;
  let identity;
  let complete = false;
  try {
    const response = await get(url, { signal: controller.signal });
    const total = Number(response.headers.get("content-length")) || 0;
    if (total > MAX_DOWNLOAD_BYTES) {
      throw new Error(`download exceeds ${MAX_DOWNLOAD_BYTES}-byte limit`);
    }
    const hash = crypto.createHash("sha256");
    out = fs.openSync(file, "wx");
    identity = fs.fstatSync(out, { bigint: true });
    let received = 0;
    let shown = -1;
    for await (const chunk of response.body) {
      if (chunk.byteLength > MAX_DOWNLOAD_BYTES - received) {
        throw new Error(`download exceeds ${MAX_DOWNLOAD_BYTES}-byte limit`);
      }
      let offset = 0;
      while (offset < chunk.byteLength) {
        const written = fs.writeSync(out, chunk, offset, chunk.byteLength - offset);
        if (written === 0) throw new Error(`could not write ${file}`);
        offset += written;
        received += written;
      }
      hash.update(chunk);
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
    const digest = hash.digest("hex");
    fs.closeSync(out);
    out = undefined;
    complete = true;
    return digest;
  } finally {
    if (!complete) controller.abort();
    try {
      if (out !== undefined) fs.closeSync(out);
    } finally {
      if (identity && !complete) {
        let current;
        try {
          current = fs.lstatSync(file, { bigint: true });
        } catch {
          // Leave an unidentifiable path to the private staging owner.
        }
        if (
          current?.isFile() &&
          identity.ino > 0n &&
          current.dev === identity.dev &&
          current.ino === identity.ino
        ) {
          fs.rmSync(file, { force: true });
        }
      }
      if (tty) process.stderr.write("\r\x1b[2K");
    }
  }
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
      `no T3 Code CLI build is available for ${key} (supported: ${SUPPORTED.join(", ")}).\n` +
        "The desktop app is at https://github.com/pingdotgg/t3code/releases",
    );
  }
  const dir = path.join(t3Home(), "runtime", "versions", version);
  if (!isComplete(dir)) await install(dir, key);

  // Service IPC and signals must reach the child; terminal Ctrl-C already does, so do not forward SIGINT twice.
  const ipc = process.send !== undefined;
  const child = spawn(
    path.join(dir, process.platform === "win32" ? "t3.exe" : "t3"),
    process.argv.slice(2),
    {
      stdio: ipc ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
      // The executable lives in the T3 home, so this is how it knows npm launched it.
      env: { ...process.env, T3CODE_NPM_LAUNCHER_PATH: import.meta.filename },
    },
  );
  if (ipc) {
    process.on("message", (message) => child.connected && child.send(message));
    child.on("message", (message) => process.connected && process.send(message));
    process.on("disconnect", () => child.connected && child.disconnect());
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => (ipc || signal !== "SIGINT") && child.kill(signal));
  }
  child.on("error", (error) => fail(error));
  child.on("exit", (code, signal) =>
    process.exit(code ?? 128 + (os.constants.signals[signal] || 1)),
  );
}

function fail(error) {
  process.stderr.write(`t3: ${error.message}\n`);
  process.exit(1);
}

await main().catch(fail);
