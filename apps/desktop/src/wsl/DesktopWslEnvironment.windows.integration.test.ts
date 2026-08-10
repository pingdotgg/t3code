// @effect-diagnostics nodeBuiltinImport:off - real Windows/WSL integration requires direct Node process and filesystem APIs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopWslEnvironment from "./DesktopWslEnvironment.ts";

const enabled = process.platform === "win32" && process.env.T3CODE_WSL_INTEGRATION === "1";
const repoRoot = NodePath.resolve(import.meta.dirname, "../../../..");
const packageJson = JSON.parse(NodeFS.readFileSync(NodePath.join(repoRoot, "package.json"), "utf8")) as {
  readonly engines?: { readonly node?: string };
};
const requiredNodeRange = packageJson.engines?.node ?? "^24.13.1";

const makeLayer = () => {
  const environmentLayer = DesktopEnvironment.layer({
    dirname: NodePath.join(repoRoot, "apps", "desktop", "dist-electron"),
    homeDirectory: process.env.USERPROFILE ?? NodePath.join(repoRoot, ".wsl-ci-home"),
    platform: "win32",
    processArch: "x64",
    appVersion: "0.0.0-wsl-ci",
    appPath: repoRoot,
    isPackaged: false,
    resourcesPath: repoRoot,
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          T3CODE_HOME: NodePath.join(repoRoot, ".wsl-ci-state"),
        }),
      ),
    ),
  );

  return DesktopWslEnvironment.layer.pipe(
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(NodeServices.layer),
  );
};

function runWsl(distro: string, args: readonly string[]) {
  const result = NodeChildProcess.spawnSync("wsl.exe", ["--distribution", distro, "--", ...args], {
    encoding: "utf8",
    timeout: 20_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `wsl.exe ${distro} command failed (${String(result.status)}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

function waitForAnnouncement(
  child: NodeChildProcess.ChildProcessWithoutNullStreams,
  prefix: string,
  timeoutMs = 10_000,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${prefix}. stdout=${stdout} stderr=${stderr}`));
    }, timeoutMs);
    const settle = (callback: () => void) => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      callback();
    };
    const onStdout = (chunk: Buffer | string) => {
      stdout += chunk.toString();
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.startsWith(prefix)) continue;
        const port = Number.parseInt(line.slice(prefix.length), 10);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
          settle(() => reject(new Error(`Invalid port announcement: ${line}`)));
          return;
        }
        settle(() => resolve(port));
        return;
      }
    };
    const onStderr = (chunk: Buffer | string) => {
      stderr += chunk.toString();
    };
    const onExit = (code: number | null) => {
      settle(() =>
        reject(new Error(`WSL child exited before ${prefix} (code ${String(code)}): ${stderr}`)),
      );
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);
  });
}

async function startPortBlocker(distro: string, nodePath: string, host: string) {
  const script = [
    'const net=require("node:net")',
    'const host=process.argv[1]',
    'const server=net.createServer()',
    'server.listen({host,port:0,exclusive:true},()=>console.log("T3CODE_BLOCKER:"+server.address().port))',
    'process.stdin.resume()',
    'process.stdin.once("data",()=>server.close(()=>process.exit(0)))',
    'setTimeout(()=>process.exit(23),30000).unref()',
  ].join(";");
  const child = NodeChildProcess.spawn(
    "wsl.exe",
    ["--distribution", distro, "--", nodePath, "-e", script, host],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const port = await waitForAnnouncement(child, "T3CODE_BLOCKER:");
  return { child, port };
}

async function stopPortBlocker(child: NodeChildProcess.ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill();
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.stdin.write("stop\n");
  });
}

async function startOneShotHttpServer(distro: string, nodePath: string, host: string) {
  const script = [
    'const http=require("node:http")',
    'const host=process.argv[1]',
    'const server=http.createServer((req,res)=>{if(req.url!=="/healthz"){res.statusCode=404;res.end("missing");return}res.end("ok");server.close()})',
    'server.listen({host,port:0,exclusive:true},()=>console.log("T3CODE_HTTP:"+server.address().port))',
    'setTimeout(()=>process.exit(24),30000).unref()',
  ].join(";");
  const child = NodeChildProcess.spawn(
    "wsl.exe",
    ["--distribution", distro, "--", nodePath, "-e", script, host],
    { stdio: ["ignore", "pipe", "pipe"] },
  ) as NodeChildProcess.ChildProcessWithoutNullStreams;
  const port = await waitForAnnouncement(child, "T3CODE_HTTP:");
  return { child, port };
}

async function fetchHealth(url: string): Promise<string> {
  let lastError: unknown = null;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return await response.text();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Windows could not reach WSL backend at ${url}: ${String(lastError)}`);
}

describe("DesktopWslEnvironment Windows/WSL2 integration", () => {
  it.effect(
    "uses concrete WSL2 distros, bundled Node, Linux-owned ports, and Windows-to-WSL HTTP reachability",
    () => {
      if (!enabled) return Effect.void;

      return Effect.gen(function* () {
        const distroNames = (process.env.T3CODE_WSL_TEST_DISTROS ?? "Ubuntu-24.04")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        const bundledNodeWindowsPath = process.env.T3CODE_WSL_TEST_BUNDLED_NODE_WINDOWS_PATH;
        assert.isString(bundledNodeWindowsPath);
        if (!bundledNodeWindowsPath) throw new Error("Missing bundled Node fixture path");

        const fixtureDir = NodePath.join(process.env.RUNNER_TEMP ?? repoRoot, "T3 Code WSL path fixture");
        NodeFS.mkdirSync(fixtureDir, { recursive: true });
        const fixturePath = NodePath.join(fixtureDir, "space path.txt");
        NodeFS.writeFileSync(fixturePath, "t3code-wsl-ci\n", "utf8");

        const environment = yield* DesktopWslEnvironment.DesktopWslEnvironment;
        assert.isTrue(yield* environment.isAvailable);
        const distros = yield* environment.probeDistros;

        const expectedDefault = process.env.T3CODE_WSL_EXPECTED_DEFAULT_DISTRO;
        if (expectedDefault) {
          assert.equal(
            distros.find((distro) => distro.isDefault)?.name,
            expectedDefault,
            "CI intentionally changes the Windows default distro so concrete-distro pinning is exercised",
          );
        }

        for (const distroName of distroNames) {
          const distro = distros.find((candidate) => candidate.name === distroName);
          assert.isDefined(distro, `Expected WSL distro ${distroName}`);
          assert.equal(distro?.version, 2, `${distroName} must be WSL2`);

          const converted = yield* environment.windowsToWslPath(distroName, fixturePath);
          assert.isTrue(Option.isSome(converted), `wslpath conversion failed in ${distroName}`);
          if (Option.isSome(converted)) {
            assert.match(converted.value, /^\//);
            assert.include(converted.value, "T3 Code WSL path fixture");
            assert.equal(
              runWsl(distroName, ["/bin/sh", "-c", 'cat "$1"', "sh", converted.value]),
              "t3code-wsl-ci",
            );
          }

          const prepared = yield* environment.ensureNodePty(distroName, repoRoot, {
            allowBuild: false,
            nodeEngineRange: requiredNodeRange,
            bundledNodeWindowsPath,
          });
          assert.isTrue(prepared.ok, prepared.ok ? undefined : prepared.reason);
          if (!prepared.ok) throw new Error(prepared.reason);

          assert.match(
            runWsl(distroName, [prepared.nodePath, "-p", "process.versions.node"]),
            /^\d+\.\d+\.\d+(?:[-+].+)?$/,
          );

          // Deliberately corrupt the Linux cache. The next packaged-runtime
          // preflight must hash-detect and repair it from the Windows resource.
          runWsl(distroName, [
            "/bin/sh",
            "-c",
            'printf corrupted > "$1"',
            "sh",
            prepared.nodePath,
          ]);
          const repaired = yield* environment.ensureNodePty(distroName, repoRoot, {
            allowBuild: false,
            nodeEngineRange: requiredNodeRange,
            bundledNodeWindowsPath,
          });
          assert.isTrue(repaired.ok, repaired.ok ? undefined : repaired.reason);
          if (!repaired.ok) throw new Error(repaired.reason);
          assert.equal(repaired.nodePath, prepared.nodePath);

          const distroIp = yield* environment.getDistroIp(distroName);
          const host = Option.getOrElse(distroIp, () => "127.0.0.1");

          const blocker = yield* Effect.promise(() =>
            startPortBlocker(distroName, repaired.nodePath, host),
          );
          try {
            const fallback = yield* environment.allocateTcpPort({
              distro: distroName,
              nodePath: repaired.nodePath,
              host,
              preferredPort: blocker.port,
              fallbackToEphemeral: true,
            });
            assert.isTrue(fallback.ok, fallback.ok ? undefined : fallback.reason);
            if (fallback.ok) {
              assert.notEqual(fallback.port, blocker.port);
              assert.isTrue(fallback.usedEphemeralFallback);
            }

            const fixed = yield* environment.allocateTcpPort({
              distro: distroName,
              nodePath: repaired.nodePath,
              host,
              preferredPort: blocker.port,
              fallbackToEphemeral: false,
            });
            assert.isFalse(fixed.ok);
            if (!fixed.ok) assert.include(fixed.reason, "EADDRINUSE");
          } finally {
            yield* Effect.promise(() => stopPortBlocker(blocker.child));
          }

          const httpServer = yield* Effect.promise(() =>
            startOneShotHttpServer(distroName, repaired.nodePath, host),
          );
          const url = `http://${host}:${httpServer.port}/healthz`;
          assert.equal(yield* Effect.promise(() => fetchHealth(url)), "ok");
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => {
                  httpServer.child.kill();
                  reject(new Error(`WSL HTTP server did not exit after health request: ${url}`));
                }, 5_000);
                httpServer.child.once("exit", (code) => {
                  clearTimeout(timeout);
                  if (code === 0) resolve();
                  else reject(new Error(`WSL HTTP server exited with ${String(code)}`));
                });
              }),
          );
        }
      }).pipe(Effect.provide(makeLayer()));
    },
  );
});
