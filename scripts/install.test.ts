// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell installer against a local GitHub fixture.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const nightlies = Array.from({ length: 100 }, (_, index) => ({
  tag_name: `v1.2.4-nightly.20261020.${200 - index}`,
}));

// regression: #22490
describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer channel lookup", () => {
  it.each([
    ["stable", "1.2.3"],
    ["preview", "1.2.4-preview.20261019.50"],
  ])("finds the newest %s release behind a full page of nightlies", async (channel, version) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-index-"));
    const target = NodePath.join(root, "home/runtime/versions", version);
    const server = NodeHttp.createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://fixture");
      const body =
        url.pathname === "/pingdotgg/t3code/releases/latest" &&
        request.headers.accept === "application/json"
          ? { tag_name: "v1.2.3" }
          : url.pathname === "/repos/pingdotgg/t3code/releases"
            ? { "1": nightlies, "2": [{ tag_name: `v${version}` }, { tag_name: "v1.2.3" }] }[
                url.searchParams.get("page") ?? ""
              ]
            : undefined;
      if (body === undefined) response.statusCode = 404;
      // The API pretty-prints and the installer reads it line by line.
      response.end(JSON.stringify(body ?? [], null, 2));
    });
    try {
      // An existing completed install isolates release resolution from archive downloads.
      await NodeFSP.mkdir(target, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(target, ".install-complete"), `${version}\n`);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const origin = `http://127.0.0.1:${address.port}`;
      const source = await NodeFSP.readFile(
        NodePath.resolve(import.meta.dirname, "install.sh"),
        "utf8",
      );
      const installer = NodePath.join(root, "install.sh");
      await NodeFSP.writeFile(installer, source.replace(/https:\/\/(api\.)?github\.com/g, origin));
      const { code, output } = await new Promise<{ code: number | null; output: string }>(
        (resolve, reject) => {
          const child = NodeChildProcess.spawn("sh", [installer], {
            env: {
              ...process.env,
              T3CODE_VERSION: "",
              T3CODE_CHANNEL: channel,
              T3CODE_HOME: NodePath.join(root, "home"),
              T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
              // A wrong version must fail here instead of downloading a real release.
              T3CODE_RELEASE_BASE_URL: origin,
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let output = "";
          child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
          child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, output }));
        },
      );
      expect(code, output).toBe(0);
      expect(output).toContain(`Installed T3 Code ${version}`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

/** Runs an installer for a version that is already unpacked, so only the t3 command step runs. */
async function installOver(input: {
  readonly script: "install.sh" | "install.ps1";
  readonly home: string;
  readonly binDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}) {
  const target = NodePath.join(input.home, "runtime", "versions", "1.2.3");
  await NodeFSP.mkdir(target, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(target, ".install-complete"), "1.2.3\n");
  const installer = NodePath.resolve(import.meta.dirname, input.script);
  const [command, args] =
    input.script === "install.sh"
      ? ["sh", [installer]]
      : ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer]];
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    env: {
      ...process.env,
      T3CODE_CHANNEL: "",
      T3CODE_VERSION: "1.2.3",
      T3CODE_HOME: input.home,
      T3CODE_INSTALL_BIN_DIR: input.binDir,
      T3CODE_RELEASE_BASE_URL: "http://127.0.0.1:9",
      ...input.env,
    },
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}`, target };
}

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("install.sh t3 command", () => {
  it("replaces only this home's own links and prints a PATH command", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-link-"));
    try {
      const home = NodePath.join(root, "home");
      const binDir = NodePath.join(root, "bin");
      const link = NodePath.join(binDir, "t3");
      await NodeFSP.mkdir(binDir, { recursive: true });

      await NodeFSP.writeFile(link, "#!/bin/sh\necho mine\n");
      const foreign = await installOver({ script: "install.sh", home, binDir });
      expect(foreign.code).not.toBe(0);
      expect(foreign.output).toContain(`another t3 is already at ${link}`);
      expect(await NodeFSP.readFile(link, "utf8")).toBe("#!/bin/sh\necho mine\n");
      // Not even from inside the versions folder, where `.` would resolve into it.
      const fromVersions = await installOver({
        script: "install.sh",
        home,
        binDir,
        cwd: foreign.target,
      });
      expect(fromVersions.code).not.toBe(0);
      expect(await NodeFSP.readFile(link, "utf8")).toBe("#!/bin/sh\necho mine\n");

      // A link that only looks like it points into versions (join() would normalize the ..).
      await NodeFSP.rm(link);
      await NodeFSP.mkdir(NodePath.join(home, "other"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(home, "other/t3"), "#!/bin/sh\n");
      await NodeFSP.symlink(`${home}/runtime/versions/../../other/t3`, link);
      const climbing = await installOver({ script: "install.sh", home, binDir });
      expect(climbing.code).not.toBe(0);
      expect(await NodeFSP.readlink(link)).toBe(`${home}/runtime/versions/../../other/t3`);

      // An upgrade over an older version's link, written through a symlinked T3 home.
      await NodeFSP.rm(link);
      await NodeFSP.symlink(NodePath.join(home, "runtime/versions/1.0.0/t3"), link);
      await NodeFSP.symlink(home, NodePath.join(root, "alias"));
      const upgrade = await installOver({
        script: "install.sh",
        home: NodePath.join(root, "alias"),
        binDir,
        env: { HOME: root, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" },
      });
      expect(upgrade.code, upgrade.output).toBe(0);
      expect(await NodeFSP.readlink(link)).toBe(
        NodePath.join(root, "alias/runtime/versions/1.2.3/t3"),
      );
      expect(upgrade.output).toContain(
        `printf '\\n%s\\n' 'export PATH="$PATH:$HOME/bin"' >> ~/.zshrc`,
      );

      // Containers and CI often have no SHELL; `set -u` must not stop the installer there.
      const noShell = await installOver({
        script: "install.sh",
        home,
        binDir,
        env: { HOME: root, SHELL: undefined, PATH: "/usr/bin:/bin" },
      });
      expect(noShell.code, noShell.output).toBe(0);
      expect(noShell.output).toContain(`Add ${binDir} to your PATH`);

      // A relative folder is made absolute, so the PATH command never follows the working directory.
      const relative = await installOver({
        script: "install.sh",
        home,
        binDir: "bin",
        cwd: root,
        env: { HOME: root, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" },
      });
      expect(relative.code, relative.output).toBe(0);
      expect(relative.output).toContain(`'export PATH="$PATH:$HOME/bin"'`);

      await NodeFSP.rm(link);
      await NodeFSP.symlink(NodePath.join(home, "bin/t3"), link);
      const overDesktop = await installOver({
        script: "install.sh",
        home: `${home}//`,
        binDir: `${binDir}/`,
      });
      expect(overDesktop.code, overDesktop.output).toBe(0);
      expect(await NodeFSP.readlink(link)).toBe(NodePath.join(home, "runtime/versions/1.2.3/t3"));
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(HostProcess.Platform.defaultValue() !== "win32")("install.ps1 t3 command", () => {
  it("replaces only its own t3.cmd, also in non-ASCII and bracketed paths", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-ps1-"));
    try {
      // Windows PowerShell 5.1 reads files as ANSI by default and expands wildcards in paths.
      const home = NodePath.join(root, "José", ".t3");
      const binDir = NodePath.join(root, "bin[t3]");
      const shim = NodePath.join(binDir, "t3.cmd");
      await NodeFSP.mkdir(binDir, { recursive: true });

      const desktopShim = '@echo off\r\n"C:\\Program Files\\T3 Code\\T3 Code.exe" "x" %*\r\n';
      await NodeFSP.writeFile(shim, desktopShim);
      const foreign = await installOver({ script: "install.ps1", home, binDir });
      expect(foreign.code).not.toBe(0);
      expect(foreign.output).toContain("another t3 is already at");
      expect(await NodeFSP.readFile(shim, "utf8")).toBe(desktopShim);

      // A hand-edited wrapper may set its own environment; replacing it would drop that.
      const edited = `@echo off\r\nset "T3CODE_HOME=D:\\other"\r\n"${NodePath.join(home, "runtime", "versions", "1.0.0", "t3.exe")}" %*`;
      await NodeFSP.writeFile(shim, edited, "utf8");
      const wrapper = await installOver({ script: "install.ps1", home, binDir });
      expect(wrapper.code).not.toBe(0);
      expect(await NodeFSP.readFile(shim, "utf8")).toBe(edited);

      const climbing = `@echo off\r\n"${NodePath.join(home, "runtime", "versions")}\\..\\other\\t3.exe" %*`;
      await NodeFSP.writeFile(shim, climbing, "utf8");
      const outside = await installOver({ script: "install.ps1", home, binDir });
      expect(outside.code).not.toBe(0);
      expect(await NodeFSP.readFile(shim, "utf8")).toBe(climbing);

      const older = NodePath.join(home, "runtime", "versions", "1.0.0", "t3.exe");
      await NodeFSP.writeFile(shim, `@echo off\r\n"${older}" %*`, "utf8");
      const upgrade = await installOver({ script: "install.ps1", home, binDir });
      expect(upgrade.code, upgrade.output).toBe(0);
      expect(await NodeFSP.readFile(shim, "utf8")).toContain(
        NodePath.join(upgrade.target, "t3.exe"),
      );

      const again = await installOver({ script: "install.ps1", home, binDir });
      expect(again.code, again.output).toBe(0);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer checksum", () => {
  it.each(
    ["home\\data", "home\ndata"].flatMap((homeName) =>
      [true, false].map((validChecksum) => ({ homeName, validChecksum })),
    ),
  )(
    "verifies home $homeName with valid checksum $validChecksum",
    async ({ homeName, validChecksum }) => {
      const availableTools = ["sha256sum", "shasum"].filter(
        (tool) =>
          NodeChildProcess.spawnSync("sh", ["-c", 'command -v "$1"', "sh", tool]).status === 0,
      );
      expect(availableTools.length).toBeGreaterThan(0);
      for (const checksumTool of availableTools) {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-checksum-"));
        const home = NodePath.join(root, homeName);
        const version = "1.2.3";
        const stem = `t3-${version}-linux-${HostProcess.Architecture.defaultValue()}`;
        const archiveName = `${stem}.tar.gz`;
        const server = NodeHttp.createServer();
        try {
          const tools = NodePath.join(root, "tools");
          await NodeFSP.mkdir(tools);
          for (const command of [
            "sh",
            "uname",
            "tar",
            "gzip",
            "cut",
            "curl",
            "grep",
            "mkdir",
            "mktemp",
            "rm",
            "mv",
            "ln",
            checksumTool,
          ]) {
            const executable = NodeChildProcess.execFileSync(
              "sh",
              ["-c", 'command -v "$1"', "sh", command],
              { encoding: "utf8" },
            ).trim();
            await NodeFSP.symlink(executable, NodePath.join(tools, command));
          }
          await NodeFSP.mkdir(NodePath.join(root, stem));
          await NodeFSP.writeFile(
            NodePath.join(root, stem, "t3"),
            "#!/bin/sh\necho 't3 v1.2.3'\n",
            { mode: 0o755 },
          );
          const archivePath = NodePath.join(root, archiveName);
          NodeChildProcess.execFileSync("tar", ["-czf", archivePath, "-C", root, stem]);
          const archive = await NodeFSP.readFile(archivePath);
          const digest = NodeCrypto.createHash("sha256").update(archive).digest("hex");
          server.on("request", (request, response) => {
            response.end(
              request.url?.endsWith("/SHA256SUMS")
                ? `${validChecksum ? digest : "0".repeat(64)}  ${archiveName}\n`
                : archive,
            );
          });
          await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
          const { code, output } = await new Promise<{ code: number | null; output: string }>(
            (resolve, reject) => {
              const child = NodeChildProcess.spawn(
                "sh",
                [NodePath.resolve(import.meta.dirname, "install.sh")],
                {
                  env: {
                    ...process.env,
                    PATH: tools,
                    T3CODE_VERSION: version,
                    T3CODE_HOME: home,
                    T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
                    T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
                  },
                  stdio: ["ignore", "pipe", "pipe"],
                },
              );
              let output = "";
              child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
              child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
              child.on("error", reject);
              child.on("close", (code) => resolve({ code, output }));
            },
          );
          const versions = NodePath.join(home, "runtime/versions");
          if (validChecksum) {
            expect(code, `${checksumTool}: ${output}`).toBe(0);
            expect(
              await NodeFSP.readFile(NodePath.join(versions, version, ".install-complete"), "utf8"),
            ).toBe("1.2.3\n");
            expect(
              NodeChildProcess.execFileSync(NodePath.join(root, "bin/t3"), ["--version"], {
                encoding: "utf8",
              }).trim(),
            ).toBe("t3 v1.2.3");
          } else {
            expect(code).not.toBe(0);
            expect(output).toContain("checksum mismatch");
            expect(output).not.toContain("Installed T3 Code");
            expect(await NodeFSP.readdir(versions)).toEqual([]);
          }
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await NodeFSP.rm(root, { recursive: true, force: true });
        }
      }
    },
  );
});
