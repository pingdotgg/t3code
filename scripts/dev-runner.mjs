import { spawn } from "node:child_process";

const BASE_SERVER_PORT = 3773;
const BASE_WEB_PORT = 5173;
const MAX_HASH_OFFSET = 3000;
const MODE_ARGS = {
  dev: [
    "run",
    "dev",
    "--ui=tui",
    "--filter=@t3tools/contracts",
    "--filter=@t3tools/web",
    "--filter=t3",
    "--parallel",
  ],
  "dev:server": ["run", "dev", "--filter=t3"],
  "dev:web": ["run", "dev", "--filter=@t3tools/web"],
  "dev:desktop": ["run", "dev", "--filter=@t3tools/desktop", "--filter=@t3tools/web", "--parallel"],
};

function parseInteger(value, envName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid ${envName}: ${value}`);
  }
  return parsed;
}

function hashSeed(seed) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function resolveOffset() {
  const explicitOffset = process.env.T3CODE_PORT_OFFSET?.trim();
  if (explicitOffset) {
    const parsed = parseInteger(explicitOffset, "T3CODE_PORT_OFFSET");
    if (parsed < 0) {
      throw new Error(`Invalid T3CODE_PORT_OFFSET: ${explicitOffset}`);
    }
    return { offset: parsed, source: `T3CODE_PORT_OFFSET=${explicitOffset}` };
  }

  const seed = process.env.T3CODE_DEV_INSTANCE?.trim();
  if (!seed) {
    return { offset: 0, source: "default ports" };
  }

  if (/^\d+$/.test(seed)) {
    return { offset: Number(seed), source: `numeric T3CODE_DEV_INSTANCE=${seed}` };
  }

  const offset = (hashSeed(seed) % MAX_HASH_OFFSET) + 1;
  return { offset, source: `hashed T3CODE_DEV_INSTANCE=${seed}` };
}

function main() {
  const mode = process.argv[2];
  const isDryRun = process.argv.includes("--dry-run");
  if (!mode || !(mode in MODE_ARGS)) {
    const supportedModes = Object.keys(MODE_ARGS).join(", ");
    throw new Error(`Usage: bun scripts/dev-runner.mjs <mode>. Supported modes: ${supportedModes}`);
  }

  const { offset, source } = resolveOffset();
  const serverPort = BASE_SERVER_PORT + offset;
  const webPort = BASE_WEB_PORT + offset;

  if (serverPort > 65535 || webPort > 65535) {
    throw new Error(
      `Port offset too large (${offset}). Computed ports: server=${serverPort}, web=${webPort}`,
    );
  }

  const env = {
    ...process.env,
    T3CODE_PORT: String(serverPort),
    PORT: String(webPort),
    ELECTRON_RENDERER_PORT: String(webPort),
    VITE_WS_URL: `ws://localhost:${serverPort}`,
    VITE_DEV_SERVER_URL: `http://localhost:${webPort}`,
  };

  if (mode === "dev" || mode === "dev:server" || mode === "dev:web") {
    // Running server/web in browser mode should not inherit desktop launcher state.
    env.T3CODE_MODE = "web";
    delete env.T3CODE_NO_BROWSER;
    delete env.T3CODE_AUTH_TOKEN;
    delete env.T3CODE_DESKTOP_WS_URL;
  }

  if (mode === "dev" && !env.T3CODE_LOG_WS_EVENTS) {
    env.T3CODE_LOG_WS_EVENTS = "1";
  }

  console.info(
    `[dev-runner] mode=${mode} source=${source} serverPort=${serverPort} webPort=${webPort}`,
  );

  if (isDryRun) {
    return;
  }

  const command = process.platform === "win32" ? "turbo.cmd" : "turbo";
  const child = spawn(command, MODE_ARGS[mode], {
    stdio: "inherit",
    env,
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on("error", (error) => {
    console.error("[dev-runner] failed to start turbo", error);
    process.exit(1);
  });
}

try {
  main();
} catch (error) {
  console.error("[dev-runner]", error);
  process.exit(1);
}
