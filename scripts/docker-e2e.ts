// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off globalConsole:off - Host-side Docker automation owns subprocesses, timing, HTTP probes, and terminal reporting.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

interface CommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly inherit?: boolean;
  readonly tolerateFailure?: boolean;
}

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = join(repositoryRoot, "compose.yaml");
const runSuffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`.toLowerCase();
const projectName = `t3docker${runSuffix}`;
const imageName = `t3-code-e2e:${runSuffix}`;
const stableHostname = "t3-code-e2e";
const syntheticCredential = `synthetic-docker-e2e-${runSuffix}`;
const buildContextCanaryRoot = join(repositoryRoot, ".docker-e2e-canary");
const buildContextCanaries = [
  join(buildContextCanaryRoot, ".codex", "auth.json"),
  join(buildContextCanaryRoot, ".claude.json"),
  join(buildContextCanaryRoot, ".cursor", "cli-config.json"),
  join(buildContextCanaryRoot, ".config", "opencode", "auth.json"),
] as const;

function redact(value: string): string {
  return value
    .replace(/(pair#token=)[A-Za-z0-9_-]+/giu, "$1<redacted>")
    .replace(/^(Token:\s*).+$/gimu, "$1<redacted>")
    .replace(/(authorization:\s*bearer\s+)[A-Za-z0-9._-]+/giu, "$1<redacted>");
}

async function run(
  command: string,
  args: ReadonlyArray<string>,
  options: CommandOptions = {},
): Promise<CommandResult> {
  return await new Promise((complete, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: options.env ?? process.env,
      shell: false,
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => {
      const result = { code: code ?? 1, stdout, stderr };
      if (result.code === 0 || options.tolerateFailure) {
        complete(result);
        return;
      }
      reject(
        new Error(
          redact(
            `${command} ${args.join(" ")} failed with exit code ${result.code}\n${stdout}${stderr}`,
          ),
        ),
      );
    });
  });
}

async function freeTcpPort(): Promise<number> {
  return await new Promise((complete, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Docker E2E could not reserve a TCP port."));
        return;
      }
      server.close((error) => (error ? reject(error) : complete(address.port)));
    });
  });
}

async function waitForDescriptor(port: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 120_000;
  const url = `http://127.0.0.1:${port}/.well-known/t3/environment`;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        return (await response.json()) as Record<string, unknown>;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((complete) => setTimeout(complete, 500));
  }
  throw new Error(`T3 Code did not become ready at ${url}.`, { cause: lastError });
}

async function assertWebClient(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`T3 Code web client returned HTTP ${response.status}.`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  const html = await response.text();
  if (!contentType.includes("text/html") || !html.includes('<div id="root">')) {
    throw new Error("T3 Code did not serve the expected web client HTML.");
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

function assertSafeCleanupPath(path: string): void {
  const resolvedPath = resolve(path);
  const resolvedTemp = resolve(tmpdir());
  if (!resolvedPath.startsWith(`${resolvedTemp}${sep}t3code-docker-e2e-`)) {
    throw new Error(`Refusing to remove unexpected Docker E2E path: ${resolvedPath}`);
  }
}

function assertSafeBuildCanaryPath(path: string): void {
  const resolvedPath = resolve(path);
  if (resolvedPath !== join(repositoryRoot, ".docker-e2e-canary")) {
    throw new Error(`Refusing to remove unexpected build-context canary path: ${resolvedPath}`);
  }
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), "t3code-docker-e2e-"));
  const workspace = join(tempRoot, "workspace");
  await mkdir(workspace, { mode: 0o777 });
  await chmod(workspace, 0o777);
  const port = await freeTcpPort();
  const composeEnvironment = {
    ...process.env,
    T3_BIND_ADDRESS: "127.0.0.1",
    T3_HOSTNAME: stableHostname,
    T3_IMAGE: imageName,
    T3_PORT: String(port),
    T3_WORKSPACE_PATH: workspace,
    T3CODE_INSTALL_CURSOR: "0",
    T3CODE_INSTALL_PROVIDERS: "0",
  } satisfies NodeJS.ProcessEnv;
  const compose = (args: ReadonlyArray<string>, options: CommandOptions = {}) =>
    run("docker", ["compose", "-f", composeFile, "-p", projectName, ...args], {
      ...options,
      env: composeEnvironment,
    });

  console.log(`Docker E2E project: ${projectName}`);
  try {
    try {
      await readFile(buildContextCanaryRoot);
      throw new Error(`Refusing to replace existing path: ${buildContextCanaryRoot}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const path of buildContextCanaries) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${syntheticCredential}\n`, { encoding: "utf8", mode: 0o600 });
    }

    await run("docker", ["version"]);
    await run("docker", ["compose", "version"]);
    await compose(["config", "--quiet"]);

    console.log("Building the server-only Docker image...");
    await compose(["build"], { inherit: true });

    const imageInspection = JSON.parse(
      (await run("docker", ["image", "inspect", imageName])).stdout,
    ) as ReadonlyArray<{
      readonly Config?: { readonly Env?: ReadonlyArray<string>; readonly User?: string };
    }>;
    const imageConfig = imageInspection[0]?.Config;
    assertEqual(imageConfig?.User, "node", "runtime image user");
    for (const entry of imageConfig?.Env ?? []) {
      if (/(?:ACCESS_TOKEN|AUTH_TOKEN|API_KEY|PASSWORD|PRIVATE_KEY|SECRET_KEY)=/iu.test(entry)) {
        throw new Error(
          `Runtime image config contains a credential-like environment entry: ${entry.split("=")[0]}`,
        );
      }
    }

    const imageHistory = await run("docker", ["image", "history", "--no-trunc", imageName]);
    if (`${imageHistory.stdout}${imageHistory.stderr}`.includes(syntheticCredential)) {
      throw new Error("Synthetic credential leaked into the image history.");
    }
    await run("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "sh",
      imageName,
      "-lc",
      [
        "test ! -e /home/node/.codex/auth.json",
        "test ! -e /home/node/.claude.json",
        "test ! -e /home/node/.cursor/cli-config.json",
        "test ! -e /home/node/.config/opencode/auth.json",
      ].join(" && "),
    ]);

    console.log("Starting the Compose service...");
    await compose(["up", "-d", "--no-build"]);
    const firstDescriptor = await waitForDescriptor(port);
    await assertWebClient(port);
    assertEqual(firstDescriptor.label, stableHostname, "environment label");

    const containerId = (await compose(["ps", "-q", "t3"])).stdout.trim();
    if (!containerId) throw new Error("Compose did not return a T3 container ID.");
    const containerInspection = JSON.parse(
      (await run("docker", ["container", "inspect", containerId])).stdout,
    ) as ReadonlyArray<{
      readonly Config?: { readonly Hostname?: string; readonly User?: string };
      readonly HostConfig?: { readonly Binds?: ReadonlyArray<string> | null };
      readonly Mounts?: ReadonlyArray<{ readonly Destination?: string; readonly Type?: string }>;
    }>;
    const runningContainer = containerInspection[0];
    assertEqual(runningContainer?.Config?.Hostname, stableHostname, "container hostname");
    assertEqual(runningContainer?.Config?.User, "node", "container user");
    if (JSON.stringify(runningContainer).includes("/var/run/docker.sock")) {
      throw new Error("The Compose service unexpectedly mounts the Docker socket.");
    }

    const identity = await compose([
      "exec",
      "-T",
      "t3",
      "sh",
      "-lc",
      'printf \'%s:%s\' "$(id -u)" "$(id -g)"',
    ]);
    assertEqual(identity.stdout, "1000:1000", "container uid:gid");
    await compose([
      "exec",
      "-T",
      "t3",
      "sh",
      "-lc",
      "printf 'workspace-ok' > /workspace/.t3-docker-e2e",
    ]);
    assertEqual(
      await readFile(join(workspace, ".t3-docker-e2e"), "utf8"),
      "workspace-ok",
      "workspace write-through",
    );

    const writeSyntheticCredentials = [
      "set -eu",
      "mkdir -p /home/node/.codex /home/node/.cursor /home/node/.config/opencode",
      `printf '%s' '{\"test\":\"${syntheticCredential}\"}' > /home/node/.codex/auth.json`,
      `printf '%s' '{\"test\":\"${syntheticCredential}\"}' > /home/node/.claude.json`,
      `printf '%s' '{\"test\":\"${syntheticCredential}\"}' > /home/node/.cursor/cli-config.json`,
      `printf '%s' '{\"test\":\"${syntheticCredential}\"}' > /home/node/.config/opencode/auth.json`,
      "chmod 600 /home/node/.codex/auth.json /home/node/.claude.json /home/node/.cursor/cli-config.json /home/node/.config/opencode/auth.json",
    ].join("; ");
    await compose(["exec", "-T", "t3", "sh", "-lc", writeSyntheticCredentials]);
    const credentialHashesCommand = [
      "sha256sum",
      "/home/node/.codex/auth.json",
      "/home/node/.claude.json",
      "/home/node/.cursor/cli-config.json",
      "/home/node/.config/opencode/auth.json",
    ].join(" ");
    const originalHashes = (
      await compose(["exec", "-T", "t3", "sh", "-lc", credentialHashesCommand])
    ).stdout;
    const originalEnvironmentId = (
      await compose(["exec", "-T", "t3", "sh", "-lc", "cat /home/node/.t3/userdata/environment-id"])
    ).stdout.trim();

    console.log("Recreating the container to verify durable state...");
    await compose(["up", "-d", "--no-build", "--force-recreate"]);
    const secondDescriptor = await waitForDescriptor(port);
    assertEqual(secondDescriptor.environmentId, originalEnvironmentId, "persisted environment ID");
    assertEqual(secondDescriptor.label, stableHostname, "stable environment label");
    const recreatedHashes = (
      await compose(["exec", "-T", "t3", "sh", "-lc", credentialHashesCommand])
    ).stdout;
    assertEqual(recreatedHashes, originalHashes, "provider credential volume contents");

    console.log(
      "Docker E2E passed: build, startup, isolation, persistence, and credential checks.",
    );
  } catch (error) {
    const logs = await compose(["logs", "--no-color", "--tail", "200"], {
      tolerateFailure: true,
    });
    const diagnosticLogs = redact(`${logs.stdout}${logs.stderr}`).trim();
    if (diagnosticLogs) console.error(`Sanitized container logs:\n${diagnosticLogs}`);
    throw error;
  } finally {
    if (!/^t3docker[a-z0-9]+$/u.test(projectName)) {
      throw new Error(`Refusing to clean unexpected Compose project: ${projectName}`);
    }
    await compose(["down", "--volumes", "--remove-orphans"], { tolerateFailure: true });
    await run("docker", ["image", "rm", imageName], { tolerateFailure: true });
    assertSafeBuildCanaryPath(buildContextCanaryRoot);
    await rm(buildContextCanaryRoot, { recursive: true, force: true });
    assertSafeCleanupPath(tempRoot);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
