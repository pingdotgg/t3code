import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

// oxlint-disable-next-line t3code/no-global-process-runtime -- The native compiler targets the actual host; this script has no Effect runtime.
const hostArch = process.arch;
// oxlint-disable-next-line t3code/no-global-process-runtime -- Native compilation only runs on the actual Linux host.
const hostPlatform = process.platform;

const { values } = NodeUtil.parseArgs({
  options: { output: { type: "string" }, arch: { type: "string", default: hostArch } },
});

if (hostPlatform === "linux") {
  const machine = { x64: 62, arm64: 183 }[values.arch];
  if (machine === undefined) throw new Error(`Unsupported Linux architecture: ${values.arch}`);
  const root = NodeURL.fileURLToPath(new URL("../../../native/browser-secret/", import.meta.url));
  const source = NodePath.resolve(root, "main.c");
  const output = values.output ?? NodePath.resolve(root, "build", values.arch, "t3-browser-secret");
  const matchesArchitecture = (file) => {
    const header = NodeFS.readFileSync(file).subarray(0, 20);
    return header.toString("hex", 0, 6) === "7f454c460201" && header.readUInt16LE(18) === machine;
  };
  let current = false;
  try {
    current =
      NodeFS.statSync(output).mtimeMs >=
        Math.max(
          NodeFS.statSync(source).mtimeMs,
          NodeFS.statSync(NodeURL.fileURLToPath(import.meta.url)).mtimeMs,
        ) && matchesArchitecture(output);
  } catch {
    /* The first build has no output yet. */
  }
  if (!current) {
    let flags;
    try {
      flags = NodeChildProcess.execFileSync("pkg-config", ["--cflags", "--libs", "libsecret-1"], {
        encoding: "utf8",
      })
        .trim()
        .split(/\s+/);
    } catch (cause) {
      throw new Error(
        "Building the Linux browser import helper requires pkg-config and libsecret development headers (Ubuntu/Debian: libsecret-1-dev).",
        { cause },
      );
    }
    NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
    const temporary = `${output}.${process.pid}.tmp`;
    try {
      NodeChildProcess.execFileSync(
        process.env.CC || "cc",
        ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", temporary, ...flags],
        { stdio: "inherit" },
      );
      if (!matchesArchitecture(temporary))
        throw new Error(`C compiler did not produce a Linux ${values.arch} executable.`);
      NodeFS.renameSync(temporary, output);
    } finally {
      NodeFS.rmSync(temporary, { force: true });
    }
  }
}
