/* oxlint-disable t3code/no-global-process-runtime -- Standalone setup must run before workspace dependencies are installed. */
// @effect-diagnostics nodeBuiltinImport:off - standalone bootstrap also runs before dependencies are installed.
// @effect-diagnostics globalConsole:off globalFetch:off globalDate:off - interactive setup and endpoint verification.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeReadlinePromises from "node:readline/promises";
import { patchNativeCli } from "../src/nativeHook.js";

const home = NodeOS.homedir();
const root = NodePath.resolve(import.meta.dirname, "../../..");
const state = NodePath.join(home, ".config/t3-task-cache");
const nonInteractive = process.argv.includes("--non-interactive");
const installed = NodePath.join(home, ".local/share/t3-task-cache");
const hookConfig = NodePath.join(home, ".config/vite-plus/run-hook.json");
const legacySourceLine = '. "$HOME/.config/t3-task-cache/env"';
const sourceLine =
  '[ ! -r "$HOME/.config/t3-task-cache/env" ] || . "$HOME/.config/t3-task-cache/env"';
const profiles = [".profile", ".bashrc", ".bash_profile", ".bash_login", ".zshenv", ".zshrc"];
if (process.argv.includes("--uninstall")) {
  for (const file of profiles) {
    const path = NodePath.join(home, file);
    try {
      const original = await NodeFSP.readFile(path, "utf8");
      const next = original
        .split("\n")
        .filter((line) => line !== sourceLine && line !== legacySourceLine)
        .join("\n");
      if (next !== original) {
        if (!next.trim() && (file === ".bash_profile" || file === ".bash_login"))
          await NodeFSP.unlink(path);
        else await NodeFSP.writeFile(path, next);
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  try {
    const config = JSON.parse(await NodeFSP.readFile(hookConfig, "utf8"));
    if (config.module === NodePath.join(installed, "runHook.ts")) await NodeFSP.unlink(hookConfig);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await NodeFSP.rm(NodePath.join(state, "credentials.json"), { force: true });
  await NodeFSP.rm(NodePath.join(state, "env"), { force: true });
  await NodeFSP.rm(NodePath.join(home, ".cache/t3-task-cache/telemetry"), {
    recursive: true,
    force: true,
  });
  // Existing shells still import this path until restarted; leave a harmless loader for them.
  await NodeFSP.mkdir(installed, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(installed, "preload.mjs"),
    "// Task cache uninstalled. Safe for shells opened before uninstall.\n",
  );
  for (const file of await NodeFSP.readdir(installed)) {
    if (file !== "preload.mjs")
      await NodeFSP.rm(NodePath.join(installed, file), { recursive: true, force: true });
  }
  console.log(
    "Task cache uninstalled. Restart existing shells and agents to clear their inherited preload.",
  );
  process.exit(0);
}

const { endpoint: defaultEndpoint } = JSON.parse(
  await NodeFSP.readFile(NodePath.join(root, ".task-cache.json"), "utf8"),
);
let credentials: Record<string, { name: string; token: string }> = {};
try {
  credentials = JSON.parse(
    await NodeFSP.readFile(NodePath.join(state, "credentials.json"), "utf8"),
  );
} catch (error) {
  if (
    !(error instanceof SyntaxError) &&
    !(error instanceof Error && "code" in error && error.code === "ENOENT")
  )
    throw error;
}
const prompt = NodeReadlinePromises.createInterface({
  input: process.stdin,
  output: process.stdout,
});
let endpoint = process.env.T3_CACHE_SETUP_URL || defaultEndpoint;
let name = process.env.T3_CACHE_SETUP_NAME || credentials[endpoint]?.name;
let token = process.env.T3_CACHE_SETUP_TOKEN || credentials[endpoint]?.token;
const initialEndpoint = endpoint;
const initialName = name;
try {
  if (!nonInteractive) {
    endpoint = (await prompt.question(`Cache URL [${endpoint}]: `)).trim() || endpoint;
    name = (await prompt.question(`Developer name${name ? ` [${name}]` : ""}: `)).trim() || name;
    prompt.close();
    if (process.stdin.isTTY || !token || endpoint !== initialEndpoint || name !== initialName) {
      const savedToken = endpoint === initialEndpoint && name === initialName ? token : undefined;
      if (!process.stdin.isTTY)
        throw new Error("Use T3_CACHE_SETUP_TOKEN for non-interactive setup.");
      process.stdout.write(
        `Credential token (hidden)${savedToken ? " [Enter keeps saved token]" : ""}: `,
      );
      process.stdin.setRawMode(true);
      process.stdin.resume();
      token =
        (await new Promise<string>((resolve, reject) => {
          let value = "";
          const data = (chunk: Buffer) => {
            for (const character of chunk.toString()) {
              if (character === "\u0003") {
                cleanup();
                reject(new Error("Cancelled"));
                return;
              }
              if (character === "\r" || character === "\n") {
                cleanup();
                resolve(value);
                return;
              }
              if (character === "\u007f") value = value.slice(0, -1);
              else value += character;
            }
          };
          const cleanup = () => {
            process.stdin.off("data", data);
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdout.write("\n");
          };
          process.stdin.on("data", data);
        })) || savedToken;
    }
  }
} finally {
  prompt.close();
}
if (!name || !token || !/^[a-z0-9-]{1,64}$/.test(name) || token.length < 32)
  throw new Error("A valid developer name and credential token are required.");
const url = new URL(endpoint);
if (
  (url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        /^127(?:\.\d{1,3}){3}$/.test(url.hostname) ||
        url.hostname === "[::1]")
    )) ||
  url.username ||
  url.password ||
  url.search ||
  url.hash
)
  throw new Error(
    "Use an HTTPS cache endpoint without embedded credentials, query, or fragment (HTTP is only allowed on loopback).",
  );
endpoint = url.href.replace(/\/$/, "");
const response = await fetch(`${endpoint}/telemetry`, {
  method: "POST",
  headers: {
    Authorization: `Basic ${Buffer.from(`${name}:${token}`).toString("base64")}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    id: NodeCrypto.randomBytes(32).toString("hex"),
    recordedAt: Date.now(),
    host: NodeOS.hostname(),
    platform: NodeOS.platform(),
    arch: NodeOS.arch(),
    ci: false,
    runId: "setup",
    tasks: [],
  }),
  signal: AbortSignal.timeout(10_000),
});
await response.body?.cancel();
if (!response.ok)
  throw new Error(`Credential verification failed (${response.status}); nothing was installed.`);

const candidates = [NodePath.join(root, "node_modules/vite-plus/dist/bin.js")];
for (const directory of [
  process.env.VITE_PLUS_HOME,
  NodePath.join(home, ".vite-plus/current"),
  NodePath.join(home, ".local/share/vite-plus/current"),
]) {
  if (directory) candidates.push(NodePath.join(directory, "node_modules/vite-plus/dist/bin.js"));
}
for (let index = 0; index < process.argv.length; index++) {
  if (process.argv[index] === "--entrypoint") {
    const entrypoint = process.argv[++index];
    if (!entrypoint) throw new Error("Missing --entrypoint path");
    candidates.push(entrypoint);
  }
}
const targets = new Map<string, { original: string; patched: string }>();
for (const candidate of candidates) {
  try {
    const path = await NodeFSP.realpath(candidate);
    const original = await NodeFSP.readFile(path, "utf8");
    const backup = await NodeFSP.readFile(`${path}.before-task-cache`, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (backup && (original === backup || original === patchNativeCli(backup)))
      targets.set(path, { original: backup, patched: original });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

await NodeFSP.mkdir(installed, { recursive: true });
await NodeFSP.writeFile(NodePath.join(installed, "package.json"), '{"type":"module"}\n');
for (const file of [
  "runHook.ts",
  "remoteCache.ts",
  "flush.ts",
  "telemetry.ts",
  "nativeHook.js",
  "nativeRunHook.js",
  "preload.mjs",
]) {
  const destination = NodePath.join(installed, file);
  const temporary = `${destination}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.copyFile(NodePath.join(import.meta.dirname, "../src", file), temporary);
    await NodeFSP.rename(temporary, destination);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}
await NodeFSP.mkdir(NodePath.dirname(hookConfig), { recursive: true });
await NodeFSP.writeFile(
  hookConfig,
  JSON.stringify({
    rootMarker: ".task-cache.json",
    module: NodePath.join(installed, "runHook.ts"),
  }),
);
for (const [path, { original }] of targets) {
  await NodeFSP.writeFile(path, original);
  await NodeFSP.rm(`${path}.before-task-cache`, { force: true });
  await NodeFSP.rm(NodePath.join(NodePath.dirname(path), "run-hook.js"), { force: true });
}
for (const file of [
  "nativeHook.ts",
  "launcher-telemetry.ts",
  "launcherTelemetry.ts",
  "vp.ts",
  "bin",
])
  await NodeFSP.rm(NodePath.join(installed, file), { recursive: true, force: true });
await NodeFSP.mkdir(state, { recursive: true, mode: 0o700 });
credentials[endpoint] = { name, token };
const temporaryCredentials = NodePath.join(state, `.credentials-${NodeCrypto.randomUUID()}.tmp`);
try {
  await NodeFSP.writeFile(temporaryCredentials, JSON.stringify(credentials), { mode: 0o600 });
  await NodeFSP.rename(temporaryCredentials, NodePath.join(state, "credentials.json"));
} finally {
  await NodeFSP.rm(temporaryCredentials, { force: true });
}

const environmentFile = NodePath.join(state, "env");
const preload = NodeURL.pathToFileURL(NodePath.join(installed, "preload.mjs")).href;
await NodeFSP.writeFile(
  environmentFile,
  [
    `if [ -r "${NodePath.join(installed, "preload.mjs")}" ]; then`,
    `case " \${NODE_OPTIONS-} " in`,
    `  *" --import=${preload} "*) ;;`,
    `  *) export NODE_OPTIONS="\${NODE_OPTIONS:+$NODE_OPTIONS }--import=${preload}" ;;`,
    `esac`,
    `fi`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);
for (const file of profiles) {
  const path = NodePath.join(home, file);
  let original = "";
  try {
    original = await NodeFSP.readFile(path, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (file === ".bash_profile" || file === ".bash_login") {
    if (!original) continue;
    // Earlier installers created a profile that masks the user’s existing login profile.
    if (file === ".bash_profile" && [sourceLine, legacySourceLine].includes(original.trim())) {
      await NodeFSP.unlink(path);
      continue;
    }
  }
  if (original.split("\n").includes(legacySourceLine)) {
    original = original
      .split("\n")
      .filter((line) => line !== legacySourceLine)
      .join("\n");
    await NodeFSP.writeFile(path, original);
  }
  if (!original.split("\n").includes(sourceLine))
    await NodeFSP.appendFile(path, `\n${sourceLine}\n`);
}
console.log(
  "Verified credentials and installed the machine-wide Vite+ hook. Open a fresh shell to enable it in all worktrees. Executables and PATH are unchanged.",
);
