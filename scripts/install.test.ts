// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell installer through a PTY and local HTTP fixtures.
import { FORK_IDENTITY } from "@lathe/shared/forkIdentity";
import * as HostProcess from "@lathe/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

/** The launcher install.sh, `lathe install`, and `lathe update` write; exec by absolute path. */
const launcherScript = (executable: string) =>
  `#!/bin/sh\nexec '${executable.replaceAll("'", "'\\''")}' "$@"\n`;

// Fork: a post-rename release publishes each archive as lathe-* and t3-*, holding `lathe` and
// `t3`; a pre-rename one has only t3-* holding `t3`. The real installer runs without a terminal
// against each. Executables name themselves and the current t3-* asset is a pre-rename archive,
// so the output shows which asset and executable the installer chose.
describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("installer archive names", () => {
  const host = HostProcess.Platform.defaultValue() === "darwin" ? "darwin" : "linux";
  const key = `${host}-${HostProcess.Architecture.defaultValue()}`;
  const version = "1.2.3";

  const pack = async (root: string, name: string, executables: Record<string, string>) => {
    const stage = NodePath.join(root, `stage-${name}`);
    const stem = `t3-${version}-${key}`;
    await NodeFSP.mkdir(NodePath.join(stage, stem), { recursive: true });
    for (const [file, output] of Object.entries(executables)) {
      await NodeFSP.writeFile(NodePath.join(stage, stem, file), `#!/bin/sh\necho '${output}'\n`, {
        mode: 0o755,
      });
    }
    NodeChildProcess.execFileSync("tar", ["-czf", NodePath.join(root, name), "-C", stage, stem]);
    return NodeFSP.readFile(NodePath.join(root, name));
  };

  it.each([
    ["a current release", true, "lathe v1.2.3", "lathe"],
    ["a release from before the rename", false, "t3 v1.2.3", "t3"],
  ] as const)("installs from %s", async (_, current, expectedOutput, linkedName) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lathe-install-names-"));
    const assets = new Map<string, Buffer>();
    assets.set(`t3-${version}-${key}.tar.gz`, await pack(root, "legacy", { t3: "t3 v1.2.3" }));
    if (current) {
      assets.set(
        `lathe-${version}-${key}.tar.gz`,
        await pack(root, "current", { lathe: "lathe v1.2.3", t3: "alias t3 v1.2.3" }),
      );
    }
    const sums = [...assets]
      .map(
        ([name, bytes]) =>
          `${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}  ${name}\n`,
      )
      .join("");
    const requested: string[] = [];
    const server = NodeHttp.createServer((request, response) => {
      const name = request.url?.split("/").at(-1) ?? "";
      requested.push(name);
      const body = name === "SHA256SUMS" ? Buffer.from(sums) : assets.get(name);
      if (body === undefined) response.writeHead(404).end();
      else response.writeHead(200, { "Content-Length": body.length }).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
    try {
      const child = NodeChildProcess.spawn(
        "sh",
        [NodePath.resolve(import.meta.dirname, "install.sh")],
        {
          env: {
            ...process.env,
            NO_COLOR: "1",
            LATHE_VERSION: version,
            LATHE_HOME: NodePath.join(root, "home"),
            LATHE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
            LATHE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      expect(code, output).toBe(0);
      expect(requested).toEqual([
        "SHA256SUMS",
        `${current ? "lathe" : "t3"}-${version}-${key}.tar.gz`,
      ]);
      const launcher = NodePath.join(root, "bin/lathe");
      expect(await NodeFSP.readFile(launcher, "utf8")).toBe(
        launcherScript(NodePath.join(root, "home/runtime/versions", version, linkedName)),
      );
      expect(
        NodeChildProcess.execFileSync(launcher, ["--version"], { encoding: "utf8" }).trim(),
      ).toBe(expectedOutput);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

const nightlies = Array.from({ length: 100 }, (_, index) => ({
  tag_name: `v1.2.4-nightly.20261020.${200 - index}`,
}));

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer home", () => {
  it("installs a relative home from a directory ending in a newline", async () => {
    const temporaryRoot = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lathe-install-home-")),
    );
    const root = NodePath.join(temporaryRoot, "cwd\n");
    const homeName = "-custom home\\home\n";
    const home = NodePath.join(root, homeName);
    const version = "1.2.3";
    const target = NodePath.join(home, "runtime/versions", version);
    const launcher = NodePath.join(root, "bin", FORK_IDENTITY.cliBin);
    try {
      await NodeFSP.mkdir(target, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(target, ".install-complete"), `${version}\n`);
      await NodeFSP.writeFile(NodePath.join(target, "t3"), "#!/bin/sh\necho 't3 v1.2.3'\n", {
        mode: 0o755,
      });
      const install = () =>
        NodeChildProcess.spawnSync("sh", [NodePath.resolve(import.meta.dirname, "install.sh")], {
          cwd: root,
          env: {
            ...process.env,
            HOME: root,
            LATHE_HOME: homeName,
            LATHE_VERSION: version,
            LATHE_INSTALL_BIN_DIR: NodePath.dirname(launcher),
            LATHE_RELEASE_BASE_URL: "http://127.0.0.1:1",
          },
          encoding: "utf8",
        });
      // The second run replaces the launcher the first wrote, newlines in its path and all.
      const first = install();
      expect(first.status, first.stdout + first.stderr).toBe(0);
      const { status, stdout, stderr } = install();
      expect(status, stdout + stderr).toBe(0);
      expect(stderr).toContain(`Installed Lathe ${version}`);
      expect(await NodeFSP.readFile(launcher, "utf8")).toBe(
        launcherScript(NodePath.join(target, "t3")),
      );
      expect(
        NodeChildProcess.execFileSync(launcher, ["--version"], {
          cwd: NodeOS.tmpdir(),
          encoding: "utf8",
        }).trim(),
      ).toBe("t3 v1.2.3");
    } finally {
      await NodeFSP.rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

// regression: #22490
describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer channel lookup", () => {
  it.each([
    // regression: #32897
    ["stable", "1.2.3", 1],
    ["preview", "1.2.4-preview.20261019.50", 0],
  ])("finds %s %s behind nightlies and %i HTTP 504s", async (channel, version, failures) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lathe-install-index-"));
    const target = NodePath.join(root, "home/runtime/versions", version);
    const server = NodeHttp.createServer((request, response) => {
      if (failures-- > 0) return response.writeHead(504).end();
      const url = new URL(request.url ?? "/", "http://fixture");
      const body =
        url.pathname === `/${FORK_IDENTITY.releaseRepository}/releases/latest` &&
        request.headers.accept === "application/json"
          ? { tag_name: "v1.2.3" }
          : url.pathname === `/repos/${FORK_IDENTITY.releaseRepository}/releases`
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
              LATHE_VERSION: "",
              LATHE_CHANNEL: channel,
              LATHE_HOME: NodePath.join(root, "home"),
              LATHE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
              // A wrong version must fail here instead of downloading a real release.
              LATHE_RELEASE_BASE_URL: origin,
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
      expect(output).toContain(`Installed Lathe ${version}`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer terminal", () => {
  it.each([false, true])(
    "preserves download and install behavior (HTTP failure: %s)",
    async (fail) => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lathe-install-progress-"));
      const version = "1.2.3";
      const stem = `t3-${version}-linux-${HostProcess.Architecture.defaultValue()}`;
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
          LATHE_VERSION: version,
          LATHE_HOME: NodePath.join(root, "home"),
          LATHE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
          LATHE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
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
          expect(output).not.toContain("Installed Lathe");
          expect(await NodeFSP.readdir(versions)).toEqual([]);
        } else {
          expect(code).toBe(0);
          expect(sawPartialProgress).toBe(true);
          expect(output).toContain("100%");
          expect(output).toContain("0.1 / 0.1 MB");
          expect(output).toContain("Installed Lathe 1.2.3");
          expect(
            await NodeFSP.readFile(NodePath.join(versions, version, ".install-complete"), "utf8"),
          ).toBe("1.2.3\n");
          expect(
            NodeChildProcess.execFileSync(NodePath.join(root, "bin/lathe"), ["--version"], {
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

// regression: #35834
describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "installer archive download",
  () => {
    it("names the archive when it returns 404", async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lathe-install-archive-"));
      const arch = HostProcess.Architecture.defaultValue() === "arm64" ? "arm64" : "x64";
      const archive = `t3-1.2.3-linux-${arch}.tar.gz`;
      const server = NodeHttp.createServer((request, response) => {
        if (request.url === "/v1.2.3/SHA256SUMS")
          return response.end(`${"0".repeat(64)}  ${archive}\n`);
        response.writeHead(404).end();
      });
      try {
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
                  LATHE_CHANNEL: "",
                  LATHE_VERSION: "1.2.3",
                  LATHE_HOME: NodePath.join(root, "home"),
                  LATHE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
                  LATHE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
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
        expect(code, output).not.toBe(0);
        expect(output).toMatch(
          new RegExp(`${FORK_IDENTITY.cliBin} install: .*${archive.replaceAll(".", "\\.")}`),
        );
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    });
  },
);

/** Runs an installer for a version that is already unpacked, so only the lathe command step runs. */
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
      LATHE_CHANNEL: "",
      LATHE_VERSION: "1.2.3",
      LATHE_HOME: input.home,
      LATHE_INSTALL_BIN_DIR: input.binDir,
      LATHE_RELEASE_BASE_URL: "http://127.0.0.1:9",
      ...input.env,
    },
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}`, target };
}

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("install.sh lathe command", () => {
  it("replaces only this home's own launchers and prints a PATH command", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lathe-install-link-"));
    try {
      const home = NodePath.join(root, "home");
      const binDir = NodePath.join(root, "bin");
      const link = NodePath.join(binDir, FORK_IDENTITY.cliBin);
      await NodeFSP.mkdir(binDir, { recursive: true });

      await NodeFSP.writeFile(link, "#!/bin/sh\necho mine\n");
      const foreign = await installOver({ script: "install.sh", home, binDir });
      expect(foreign.code).not.toBe(0);
      expect(foreign.output).toContain(`another ${FORK_IDENTITY.cliBin} is already at ${link}`);
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

      // Only `<version>/t3` counts, not another program inside a version.
      await NodeFSP.rm(link);
      await NodeFSP.symlink(NodePath.join(home, "runtime/versions/1.0.0/helper"), link);
      const sibling = await installOver({ script: "install.sh", home, binDir });
      expect(sibling.code).not.toBe(0);
      expect(await NodeFSP.readlink(link)).toBe(
        NodePath.join(home, "runtime/versions/1.0.0/helper"),
      );

      // An upgrade over an older version's link, written through a symlinked Lathe home.
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
      expect(await NodeFSP.readFile(link, "utf8")).toBe(
        launcherScript(NodePath.join(root, "alias/runtime/versions/1.2.3/t3")),
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

      // Its folder on PATH with a trailing slash is still this lathe, not another one.
      const slashed = await installOver({
        script: "install.sh",
        home,
        binDir,
        env: { HOME: root, PATH: `${binDir}/:/usr/bin:/bin` },
      });
      expect(slashed.code, slashed.output).toBe(0);
      expect(slashed.output).toContain(`Run ${FORK_IDENTITY.cliBin} to use Lathe here`);

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

      // A launcher script someone edited is theirs now.
      const edited = `${launcherScript(NodePath.join(home, "runtime/versions/1.2.3/t3"))}# mine\n`;
      await NodeFSP.writeFile(link, edited);
      const overEdited = await installOver({ script: "install.sh", home, binDir });
      expect(overEdited.code).not.toBe(0);
      expect(await NodeFSP.readFile(link, "utf8")).toBe(edited);

      await NodeFSP.rm(link);
      await NodeFSP.symlink(NodePath.join(home, "bin", FORK_IDENTITY.cliBin), link);
      const overDesktop = await installOver({
        script: "install.sh",
        home: `${home}//`,
        binDir: `${binDir}/`,
      });
      expect(overDesktop.code, overDesktop.output).toBe(0);
      expect(await NodeFSP.readFile(link, "utf8")).toBe(
        launcherScript(NodePath.join(home, "runtime/versions/1.2.3/t3")),
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(HostProcess.Platform.defaultValue() !== "win32")(
  "install.ps1 lathe command",
  () => {
    it("replaces only its own lathe.cmd, also in non-ASCII and bracketed paths", async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lathe-install-ps1-"));
      try {
        // Windows PowerShell 5.1 reads files as ANSI by default and expands wildcards in paths.
        const home = NodePath.join(root, "José", ".lathe");
        const binDir = NodePath.join(root, "bin[t3]");
        const shim = NodePath.join(binDir, "lathe.cmd");
        await NodeFSP.mkdir(binDir, { recursive: true });

        const desktopShim = '@echo off\r\n"C:\\Program Files\\Lathe\\Lathe.exe" "x" %*\r\n';
        await NodeFSP.writeFile(shim, desktopShim);
        const foreign = await installOver({ script: "install.ps1", home, binDir });
        expect(foreign.code).not.toBe(0);
        expect(foreign.output).toContain(`another ${FORK_IDENTITY.cliBin} is already at`);
        expect(await NodeFSP.readFile(shim, "utf8")).toBe(desktopShim);

        // A hand-edited wrapper may set its own environment; replacing it would drop that.
        const edited = `@echo off\r\nset "LATHE_HOME=D:\\other"\r\n"${NodePath.join(home, "runtime", "versions", "1.0.0", "t3.exe")}" %*`;
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

        // Another lathe first on PATH still runs, so the installer names this one in full.
        const otherBin = NodePath.join(root, "other");
        await NodeFSP.mkdir(otherBin);
        await NodeFSP.writeFile(NodePath.join(otherBin, "lathe.cmd"), "@echo off\r\n");
        // Windows spells it Path; a second PATH key would be ambiguous.
        const pathKey =
          Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
        const shadowed = await installOver({
          script: "install.ps1",
          home,
          binDir,
          env: { [pathKey]: `${otherBin};${process.env[pathKey] ?? ""}` },
        });
        expect(shadowed.code, shadowed.output).toBe(0);
        expect(shadowed.output).toContain(
          `Another ${FORK_IDENTITY.cliBin} at ${NodePath.join(otherBin, "lathe.cmd")} runs first`,
        );

        // Its own folder on PATH with a trailing separator is already on PATH.
        const slashed = await installOver({
          script: "install.ps1",
          home,
          binDir,
          env: { [pathKey]: `${binDir}\\;${process.env[pathKey] ?? ""}` },
        });
        expect(slashed.code, slashed.output).toBe(0);
        expect(slashed.output).toContain("to use Lathe here");
        // The same when the install folder itself is given with a trailing separator.
        const bothSlashed = await installOver({
          script: "install.ps1",
          home,
          binDir: `${binDir}\\`,
          env: { [pathKey]: `${binDir}\\;${process.env[pathKey] ?? ""}` },
        });
        expect(bothSlashed.code, bothSlashed.output).toBe(0);
        expect(bothSlashed.output).toContain("to use Lathe here");
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    });
  },
);

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
        const root = await NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), "lathe-install-checksum-"),
        );
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
            "chmod",
            "sed",
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
                    LATHE_VERSION: version,
                    LATHE_HOME: home,
                    LATHE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
                    LATHE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
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
              NodeChildProcess.execFileSync(NodePath.join(root, "bin/lathe"), ["--version"], {
                encoding: "utf8",
              }).trim(),
            ).toBe("t3 v1.2.3");
          } else {
            expect(code).not.toBe(0);
            expect(output).toContain("checksum mismatch");
            expect(output).not.toContain("Installed Lathe");
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

// regression: #38234
describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("concurrent installers", () => {
  it("publishes one runtime without nesting the other install's staging directory", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lathe-install-concurrent-"));
    const version = "1.2.3";
    const stem = `t3-${version}-linux-${HostProcess.Architecture.defaultValue()}`;
    const archiveName = `${stem}.tar.gz`;
    const target = NodePath.join(root, "home/runtime/versions", version);
    const waiting = new Map<string, NodeHttp.ServerResponse>();
    const server = NodeHttp.createServer();
    try {
      const tools = NodePath.join(root, "tools");
      await NodeFSP.mkdir(tools);
      await NodeFSP.mkdir(NodePath.join(root, stem));
      await NodeFSP.writeFile(NodePath.join(root, stem, "t3"), "#!/bin/sh\necho 't3 v1.2.3'\n", {
        mode: 0o755,
      });
      const archivePath = NodePath.join(root, archiveName);
      NodeChildProcess.execFileSync("tar", ["-czf", archivePath, "-C", root, stem]);
      const archive = await NodeFSP.readFile(archivePath);
      const digest = NodeCrypto.createHash("sha256").update(archive).digest("hex");
      server.on("request", (request, response) => {
        if (request.url?.startsWith("/ready/")) {
          waiting.set(request.url.slice(7), response);
          if (waiting.size === 2) waiting.get("first")!.end("go");
        } else if (request.url === "/published") {
          waiting.get("second")!.end("go");
          response.end("ok");
        } else {
          response.end(
            request.url?.endsWith("/SHA256SUMS") ? `${digest}  ${archiveName}\n` : archive,
          );
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const origin = `http://127.0.0.1:${address.port}`;
      const realMv = NodeChildProcess.execFileSync("sh", ["-c", "command -v mv"], {
        encoding: "utf8",
      }).trim();
      // Hold publication until both installers have removed the destination, then let them rename in order.
      const wrapper = NodePath.join(tools, "mv.mjs");
      await NodeFSP.writeFile(
        wrapper,
        `
import { execFileSync } from 'node:child_process';
await fetch(process.env.LATHE_TEST_ORIGIN + '/ready/' + process.env.LATHE_TEST_INSTALLER);
execFileSync(${JSON.stringify(realMv)}, process.argv.slice(2));
if (process.env.LATHE_TEST_INSTALLER === 'first') await fetch(process.env.LATHE_TEST_ORIGIN + '/published');
`,
      );
      await NodeFSP.writeFile(
        NodePath.join(tools, "mv"),
        `#!/bin/sh\nexec '${process.execPath}' '${wrapper}' "$@"\n`,
        { mode: 0o755 },
      );
      const install = (id: string) =>
        new Promise<{ code: number | null; output: string }>((resolve, reject) => {
          const child = NodeChildProcess.spawn(
            "sh",
            [NodePath.join(import.meta.dirname, "install.sh")],
            {
              env: {
                ...process.env,
                PATH: `${tools}:${process.env.PATH}`,
                LATHE_VERSION: version,
                LATHE_HOME: NodePath.join(root, "home"),
                LATHE_INSTALL_BIN_DIR: NodePath.join(root, "bin", id),
                LATHE_RELEASE_BASE_URL: origin,
                LATHE_TEST_ORIGIN: origin,
                LATHE_TEST_INSTALLER: id,
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let output = "";
          child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
          child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, output }));
        });
      const results = await Promise.all([install("first"), install("second")]);
      for (const result of results) expect(result.code, result.output).toBe(0);
      expect(
        (await NodeFSP.readdir(target)).filter((name) => name.startsWith(".staging-")),
        "concurrent installs must not leave a nested runtime",
      ).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
