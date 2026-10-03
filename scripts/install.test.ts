// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell installer through a PTY and a gated HTTP fixture.
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

// util-linux's script gives the real installer a terminal without a browser or extra packages.
describe.skipIf(HostProcessPlatform.defaultValue() !== "linux")("installer terminal", () => {
  it.each([false, true])(
    "preserves download and install behavior (HTTP failure: %s)",
    async (fail) => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-progress-"));
      const version = "1.2.3";
      const stem = `t3-${version}-linux-${HostProcessArchitecture.defaultValue()}`;
      const archiveName = `${stem}.tar.gz`;
      let resumeDownload: (() => void) | undefined;
      let sawPartialProgress = false;
      let output = "";
      await NodeFSP.mkdir(NodePath.join(root, stem));
      await NodeFSP.writeFile(NodePath.join(root, stem, "t3"), "#!/bin/sh\necho 't3 v1.2.3'\n", {
        mode: 0o755,
      });
      await NodeFSP.writeFile(
        NodePath.join(root, stem, "payload"),
        NodeCrypto.randomBytes(64 * 1024),
      );
      NodeChildProcess.execFileSync("tar", [
        "-czf",
        NodePath.join(root, archiveName),
        "-C",
        root,
        stem,
      ]);
      const archive = await NodeFSP.readFile(NodePath.join(root, archiveName));
      const checksum = NodeCrypto.createHash("sha256").update(archive).digest("hex");
      const server = NodeHttp.createServer((request, response) => {
        if (request.url?.endsWith("/SHA256SUMS")) {
          response.end(`${checksum}  ${archiveName}\n`);
        } else if (fail) {
          response.writeHead(500).end();
        } else {
          response.writeHead(200, { "Content-Length": archive.length });
          resumeDownload = () => response.end(archive.subarray(Math.floor(archive.length / 2)));
          response.write(archive.subarray(0, Math.floor(archive.length / 2)));
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const installer = NodePath.resolve(import.meta.dirname, "install.sh").replaceAll(
        "'",
        "'\\''",
      );
      const child = NodeChildProcess.spawn("script", ["-qec", `sh '${installer}'`, "/dev/null"], {
        env: {
          ...process.env,
          TERM: "xterm",
          NO_COLOR: "1",
          T3CODE_VERSION: version,
          T3CODE_HOME: NodePath.join(root, "home"),
          T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
          T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const collect = (chunk: Buffer) => {
        output += chunk.toString();
        if (!sawPartialProgress && /\b[1-9]\d?%/.test(output)) {
          sawPartialProgress = true;
          resumeDownload?.();
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.on("error", reject);
          child.on("close", resolve);
        });
        const versions = NodePath.join(root, "home/runtime/versions");
        if (fail) {
          expect(code).not.toBe(0);
          expect(output).toContain("500");
          expect(output).not.toContain("100%");
          expect(output).not.toContain("Installed T3 Code");
          expect(await NodeFSP.readdir(versions)).toEqual([]);
        } else {
          expect(code).toBe(0);
          expect(sawPartialProgress).toBe(true);
          expect(output).toContain("100%");
          expect(output).toContain("0.1 / 0.1 MB");
          expect(output).toContain("Installed T3 Code 1.2.3");
          expect(
            await NodeFSP.readFile(NodePath.join(versions, version, ".install-complete"), "utf8"),
          ).toBe("1.2.3\n");
          expect(
            NodeChildProcess.execFileSync(NodePath.join(root, "bin/t3"), ["--version"], {
              encoding: "utf8",
            }).trim(),
          ).toBe("t3 v1.2.3");
          expect(await NodeFSP.readdir(versions)).toEqual([version]);
        }
      } finally {
        if (child.exitCode === null) child.kill();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );
});

// cmd.exe parses batch files with the console's codepage, so the Windows shim
// only works when its bytes survive that decode. Drive the real installer with
// a non-ASCII T3CODE_HOME and then run the shim it wrote, the way a user would.
describe.skipIf(HostProcessPlatform.defaultValue() !== "win32")("installer windows shim", () => {
  it("runs the t3.cmd shim through a non-ASCII install home", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-shim-"));
    try {
      const home = NodePath.join(root, "Déry home");
      const bin = NodePath.join(root, "bin");
      const version = "1.2.3";
      const stem = `t3-${version}-win32-x64`;
      const archiveName = `${stem}.zip`;
      const zipSource = NodePath.join(root, "zip-src");
      const staging = NodePath.join(zipSource, stem);
      await NodeFSP.mkdir(staging, { recursive: true });
      // A stub t3.exe that prints its version and echoes its arguments, so the
      // shim's `%*` forwarding is observable. Compiled with the .NET Framework
      // compiler that ships with Windows; no SDK required.
      const stubSource = NodePath.join(root, "stub.cs");
      await NodeFSP.writeFile(
        stubSource,
        [
          "public static class Stub {",
          "  public static void Main(string[] args) {",
          '    System.Console.WriteLine("t3 v1.2.3 " + string.Join(" ", args));',
          "  }",
          "}",
          "",
        ].join("\n"),
      );
      const csc = [
        "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
        "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe",
      ].find((candidate) => {
        try {
          NodeChildProcess.execFileSync(candidate, ["-help"], { stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      });
      if (!csc) throw new Error("no .NET Framework compiler found");
      NodeChildProcess.execFileSync(
        csc,
        ["-nologo", `-out:${NodePath.join(staging, "t3.exe")}`, stubSource],
        {
          stdio: "ignore",
        },
      );
      // Windows ships bsdtar at an absolute path; a GNU tar on the PATH would
      // read the `C:` drive letter as a remote host.
      NodeChildProcess.execFileSync("C:\\Windows\\System32\\tar.exe", [
        "-a",
        "-cf",
        NodePath.join(root, archiveName),
        "-C",
        zipSource,
        stem,
      ]);
      const archive = await NodeFSP.readFile(NodePath.join(root, archiveName));
      const checksum = NodeCrypto.createHash("sha256").update(archive).digest("hex");
      const server = NodeHttp.createServer((request, response) => {
        if (request.url?.endsWith("/SHA256SUMS")) {
          response.end(`${checksum}  ${archiveName}\n`);
        } else if (request.url?.endsWith(`/${archiveName}`)) {
          response.writeHead(200, { "Content-Length": archive.length }).end(archive);
        } else {
          response.writeHead(404).end();
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const child = NodeChildProcess.spawn(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          NodePath.resolve(import.meta.dirname, "install.ps1"),
        ],
        {
          env: {
            ...process.env,
            NO_COLOR: "1",
            T3CODE_CHANNEL: "stable",
            T3CODE_VERSION: version,
            T3CODE_HOME: home,
            T3CODE_INSTALL_BIN_DIR: bin,
            T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      expect(code).toBe(0);
      expect(output).toContain("Installed T3 Code 1.2.3");
      expect(
        await NodeFSP.readFile(
          NodePath.join(home, "runtime", "versions", version, ".install-complete"),
          "utf8",
        ),
      ).toBe("1.2.3");
      const shim = NodePath.join(bin, "t3.cmd");
      // windowsVerbatimArguments keeps the /s /c tail verbatim; Node's default
      // arg escaping would mangle the inner quotes cmd needs.
      const invoked = NodeChildProcess.spawnSync(
        "cmd.exe",
        ["/d", "/s", "/c", `"${shim}" one two`],
        {
          encoding: "utf8",
          windowsVerbatimArguments: true,
        },
      );
      expect(invoked.status).toBe(0);
      expect(invoked.stdout).toContain("t3 v1.2.3 one two");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
