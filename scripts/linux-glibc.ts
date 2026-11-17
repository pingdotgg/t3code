// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Runs in electron-builder's Node afterPack hook.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

// Both Linux release jobs build on Ubuntu 24.04; this is a build ceiling, not a distro support promise.
const GLIBC_BUILD_CEILING = "2.39";
const readelf = NodeUtil.promisify(NodeChildProcess.execFile);

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function parseGlibcNeeds(output: string): string | undefined {
  let inNeeds = false;
  let minimum: string | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("Version ")) inNeeds = line.startsWith("Version needs section ");
    if (!inNeeds) continue;
    const name = /\bName:\s+(GLIBC_\S+)/.exec(line)?.[1];
    if (!name) continue;
    // DT_RELR's named ABI requirement was introduced in glibc 2.36.
    const version =
      name === "GLIBC_ABI_DT_RELR" ? "2.36" : /^GLIBC_(\d+(?:\.\d+)+)$/.exec(name)?.[1];
    if (!version) throw new Error(`Unhandled glibc requirement: ${name}`);
    if (!minimum || compareVersions(version, minimum) > 0) minimum = version;
  }
  return minimum;
}

export async function scanGlibcNeeds(appOutDir: string): Promise<{
  minimum: string;
  elfCount: number;
}> {
  let minimum: string | undefined;
  let elfCount = 0;
  async function walk(directory: string): Promise<void> {
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const file = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(file);
        continue;
      }
      if (!entry.isFile()) continue;
      const handle = await NodeFSP.open(file, "r");
      let isElf: boolean;
      try {
        const magic = Buffer.alloc(4);
        await handle.read(magic, 0, 4, 0);
        isElf = magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      } finally {
        await handle.close();
      }
      if (!isElf) continue;
      elfCount++;
      try {
        // readelf inspects either release architecture without executing the binary.
        const { stdout, stderr } = await readelf("readelf", ["--wide", "--version-info", file], {
          env: { ...process.env, LC_ALL: "C" },
          maxBuffer: 16 * 1024 * 1024,
        });
        if (stderr.trim()) throw new Error(stderr.trim());
        const required = parseGlibcNeeds(stdout);
        if (required && compareVersions(required, GLIBC_BUILD_CEILING) > 0) {
          throw new Error(
            `requires GLIBC_${required}, exceeding build ceiling ${GLIBC_BUILD_CEILING}`,
          );
        }
        if (required && (!minimum || compareVersions(required, minimum) > 0)) minimum = required;
      } catch (cause) {
        throw new Error(
          `Cannot validate glibc compatibility of ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }
    }
  }
  await walk(appOutDir);
  if (elfCount === 0 || !minimum) throw new Error(`No glibc requirements found in ${appOutDir}`);
  console.log(
    `[linux-glibc] ${elfCount} ELF files; requires glibc >= ${minimum}; build ceiling ${GLIBC_BUILD_CEILING}`,
  );
  return { minimum, elfCount };
}
