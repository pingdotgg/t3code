// @effect-diagnostics nodeBuiltinImport:off - Exercises the real shell installer against a local HTTP fixture.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { describe, expect, it } from "vite-plus/test";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const version = "1.2.3";
const stem = `t3-${version}-linux-x64`;
const archiveName = `${stem}.tar.gz`;

// Serves a release whose `t3` prints `stderr` and exits with `exitCode`, then runs install.sh against it.
async function install(stderr: string, exitCode: number) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-"));
  const bin = NodePath.join(root, "bin");
  await NodeFSP.mkdir(NodePath.join(root, stem));
  await NodeFSP.mkdir(bin);
  await NodeFSP.writeFile(
    NodePath.join(root, stem, "t3"),
    `#!/bin/sh\nprintf '%s\\n' '${stderr}' >&2\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
  // Pin the platform so the Linux path also runs on macOS.
  await NodeFSP.writeFile(
    NodePath.join(bin, "uname"),
    `#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n`,
    { mode: 0o755 },
  );
  await execFile("tar", ["-czf", NodePath.join(root, archiveName), "-C", root, stem]);
  const archive = await NodeFSP.readFile(NodePath.join(root, archiveName));
  const checksum = NodeCrypto.createHash("sha256").update(archive).digest("hex");
  const server = NodeHttp.createServer((request, response) => {
    if (request.url?.endsWith("/SHA256SUMS")) response.end(`${checksum}  ${archiveName}\n`);
    else if (request.url?.endsWith(`/${archiveName}`)) response.end(archive);
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  try {
    return await execFile("sh", [NodePath.resolve(import.meta.dirname, "install.sh")], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        T3CODE_VERSION: version,
        T3CODE_HOME: NodePath.join(root, "home"),
        T3CODE_INSTALL_BIN_DIR: bin,
        T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
      },
    }).then(
      ({ stderr }) => ({ code: 0, stderr }),
      (error: { code: number; stderr: string }) => ({ code: error.code, stderr: error.stderr }),
    );
  } finally {
    server.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("install.sh", () => {
  it("names the missing libatomic package and keeps the loader error", async () => {
    const loaderError =
      "t3: error while loading shared libraries: libatomic.so.1: cannot open shared object file: No such file or directory";
    const result = await install(loaderError, 127);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(loaderError);
    expect(result.stderr).toContain("commonly named libatomic or libatomic1");
  });

  it("installs and passes through warnings when the executable runs", async () => {
    const result = await install("t3: startup warning", 0);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("t3: startup warning");
    expect(result.stderr).toContain(`Installed T3 Code ${version}`);
  });
});
