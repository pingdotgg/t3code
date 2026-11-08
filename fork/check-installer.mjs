// Proves the built Windows installer contains the fork's features, by finding
// one marker string per feature (fork/installer-markers.txt) in the packaged
// app.asar / server.asar. Needs 7-Zip (`7z` on PATH, preinstalled on GitHub's
// Windows runners).
//
// Usage: node fork/check-installer.mjs <release-dir>
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = process.argv[2] ?? "release";
const exe = readdirSync(dir)
  .filter((f) => f.endsWith(".exe"))
  .sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs)[0];
if (!exe) throw new Error(`no installer in ${dir}`);

const markers = readFileSync(new URL("./installer-markers.txt", import.meta.url), "utf8")
  .split("\n")
  .map((s) => s.trim())
  .filter((s) => s && !s.startsWith("#"));

const tmp = mkdtempSync(join(tmpdir(), "fork-installer-"));
function sevenZip(...args) {
  const r = spawnSync("7z", ["x", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`7z failed: ${r.stderr || r.stdout}`);
}
try {
  sevenZip(join(dir, exe), "$PLUGINSDIR/app-64.7z", `-o${tmp}`);
  sevenZip(
    join(tmp, "$PLUGINSDIR", "app-64.7z"),
    "resources/app.asar",
    "resources/server.asar",
    `-o${tmp}`,
  );
  let missing = markers;
  for (const f of ["app.asar", "server.asar"]) {
    const p = join(tmp, "resources", f);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "latin1");
    missing = missing.filter((m) => !text.includes(m));
  }
  if (missing.length) throw new Error(`installer ${exe} lacks: ${missing.join(", ")}`);
  console.log(`${exe}: all ${markers.length} feature markers present`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
