import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BASE_SERVER_PORT = 3773;
const BASE_WEB_PORT = 5173;
const MAX_HASH_OFFSET = 3000;
export const DEFAULT_DEV_STATE_DIR = path.join(homedir(), ".t3", "dev");
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
const FORWARDED_ENV_FLAGS = {
  "state-dir": { envName: "T3CODE_STATE_DIR", expectsValue: true },
  "auth-token": { envName: "T3CODE_AUTH_TOKEN", expectsValue: true },
  token: { envName: "T3CODE_AUTH_TOKEN", expectsValue: true },
  "no-browser": { envName: "T3CODE_NO_BROWSER", expectsValue: false },
  "auto-bootstrap-project-from-cwd": {
    envName: "T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD",
    expectsValue: false,
  },
  "log-websocket-events": { envName: "T3CODE_LOG_WS_EVENTS", expectsValue: false },
  "log-ws-events": { envName: "T3CODE_LOG_WS_EVENTS", expectsValue: false },
  host: { envName: "T3CODE_HOST", expectsValue: true },
  port: { envName: "T3CODE_PORT", expectsValue: true },
  "dev-url": { envName: "VITE_DEV_SERVER_URL", expectsValue: true },
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

export function resolveOffset(env = process.env) {
  const explicitOffset = env.T3CODE_PORT_OFFSET?.trim();
  if (explicitOffset) {
    const parsed = parseInteger(explicitOffset, "T3CODE_PORT_OFFSET");
    if (parsed < 0) {
      throw new Error(`Invalid T3CODE_PORT_OFFSET: ${explicitOffset}`);
    }
    return { offset: parsed, source: `T3CODE_PORT_OFFSET=${explicitOffset}` };
  }

  const seed = env.T3CODE_DEV_INSTANCE?.trim();
  if (!seed) {
    return { offset: 0, source: "default ports" };
  }

  if (/^\d+$/.test(seed)) {
    return { offset: Number(seed), source: `numeric T3CODE_DEV_INSTANCE=${seed}` };
  }

  const offset = (hashSeed(seed) % MAX_HASH_OFFSET) + 1;
  return { offset, source: `hashed T3CODE_DEV_INSTANCE=${seed}` };
}

function parseLongFlag(raw) {
  if (!raw.startsWith("--")) return null;
  const normalized = raw.slice(2);
  const equalsIndex = normalized.indexOf("=");
  if (equalsIndex === -1) {
    return { name: normalized, value: undefined };
  }
  return {
    name: normalized.slice(0, equalsIndex),
    value: normalized.slice(equalsIndex + 1),
  };
}

function toBooleanEnvValue(value) {
  if (value === undefined) return "1";
  const normalized = value.trim().toLowerCase();
  if (normalized === "false" || normalized === "0" || normalized === "no") return "0";
  return "1";
}

export function parseDevRunnerArgs(rawArgs) {
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs.slice();
  const envOverrides = {};
  const turboArgs = [];
  let isDryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      isDryRun = true;
      continue;
    }

    if (arg === "--") {
      turboArgs.push(...args.slice(index + 1));
      break;
    }

    const parsedFlag = parseLongFlag(arg);
    if (!parsedFlag) {
      turboArgs.push(arg);
      continue;
    }

    const definition = FORWARDED_ENV_FLAGS[parsedFlag.name];
    if (!definition) {
      turboArgs.push(arg);
      continue;
    }

    if (definition.expectsValue) {
      let value = parsedFlag.value;
      if (value === undefined) {
        const next = args[index + 1];
        if (next === undefined || next === "--" || next.startsWith("-")) {
          throw new Error(`Missing value for --${parsedFlag.name}`);
        }
        value = next;
        index += 1;
      }
      envOverrides[definition.envName] = value;
      continue;
    }

    envOverrides[definition.envName] = toBooleanEnvValue(parsedFlag.value);
  }

  return {
    isDryRun,
    envOverrides,
    turboArgs,
  };
}

function resolveStateDir(envOverrides) {
  return envOverrides.T3CODE_STATE_DIR ?? DEFAULT_DEV_STATE_DIR;
}

export function createDevRunnerEnv({ mode, env, offset, envOverrides }) {
  const serverPort = BASE_SERVER_PORT + offset;
  const webPort = BASE_WEB_PORT + offset;

  const output = {
    ...env,
    T3CODE_PORT: String(serverPort),
    PORT: String(webPort),
    ELECTRON_RENDERER_PORT: String(webPort),
    VITE_WS_URL: `ws://localhost:${serverPort}`,
    VITE_DEV_SERVER_URL: `http://localhost:${webPort}`,
    ...envOverrides,
  };

  output.T3CODE_STATE_DIR = resolveStateDir(envOverrides);

  const parsedServerPort = Number(output.T3CODE_PORT);
  if (Number.isInteger(parsedServerPort) && parsedServerPort > 0 && parsedServerPort <= 65535) {
    output.VITE_WS_URL = `ws://localhost:${parsedServerPort}`;
  }

  if (mode === "dev" || mode === "dev:server" || mode === "dev:web") {
    // Running server/web in browser mode should not inherit desktop launcher state.
    output.T3CODE_MODE = "web";
    if (!("T3CODE_NO_BROWSER" in envOverrides)) {
      delete output.T3CODE_NO_BROWSER;
    }
    if (!("T3CODE_AUTH_TOKEN" in envOverrides)) {
      delete output.T3CODE_AUTH_TOKEN;
    }
    delete output.T3CODE_DESKTOP_WS_URL;
  }

  if (mode === "dev" && !output.T3CODE_LOG_WS_EVENTS) {
    output.T3CODE_LOG_WS_EVENTS = "1";
  }

  return output;
}

export function runDevRunner(argv = process.argv) {
  const mode = argv[2];
  const parsedArgs = parseDevRunnerArgs(argv.slice(3));
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

  const env = createDevRunnerEnv({
    mode,
    env: process.env,
    offset,
    envOverrides: parsedArgs.envOverrides,
  });

  console.info(
    `[dev-runner] mode=${mode} source=${source} serverPort=${serverPort} webPort=${webPort} stateDir=${env.T3CODE_STATE_DIR}`,
  );

  if (parsedArgs.isDryRun) {
    return;
  }

  const command = process.platform === "win32" ? "turbo.cmd" : "turbo";
  const child = spawn(command, [...MODE_ARGS[mode], ...parsedArgs.turboArgs], {
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

const entrypointPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";

if (import.meta.url === entrypointPath) {
  try {
    runDevRunner();
  } catch (error) {
    console.error("[dev-runner]", error);
    process.exit(1);
  }
}
