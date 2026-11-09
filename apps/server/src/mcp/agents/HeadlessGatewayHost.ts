import { connectGatewayBridge } from "@t3tools/client-runtime/gateway";
import { GATEWAY_SCOPE_VALUES, type GatewayScope } from "@t3tools/mcp-gateway";
import {
  sharedGatewayConfigFromEnvironment,
  startSharedGatewayOwner,
  type SharedGatewayConfig,
} from "@t3tools/mcp-gateway/sharedOwner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import { forkParked } from "../../serverActivation.ts";
import * as LocalGatewayPort from "./LocalGatewayPort.ts";

/** The desktop reads the bridge token from the same file. */
const GATEWAY_ENV_FILE = [".config", "t3code", "mcp-gateway.env"] as const;

/** `KEY=value` lines, as systemd's EnvironmentFile and the desktop's credential reader accept. */
export function parseGatewayEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (match === null) continue;
    const raw = match[2]!.trim();
    const quoted = raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw.at(-1) === raw[0];
    values[match[1]!] = quoted ? raw.slice(1, -1) : raw;
  }
  return values;
}

export type HeadlessGatewaySettings =
  | { readonly enabled: false; readonly reason: string }
  | {
      readonly enabled: true;
      readonly config: SharedGatewayConfig;
      readonly scopes: ReadonlyArray<GatewayScope>;
    };

/** This host's switches plus what `sharedGatewayConfigFromEnvironment` reads. */
const LAUNCHER_ENV_KEYS = [
  "T3_MCP_HEADLESS_GATEWAY",
  "T3_MCP_HEADLESS_SCOPES",
  "T3_MCP_BRIDGE_PORT",
  "T3_MCP_BRIDGE_TOKEN",
  "T3_MCP_REPOSITORY_ALLOWLIST",
  "T3_MCP_EVENT_RETENTION",
  "T3_MCP_STATE_FILE",
  "T3_MCP_GRANTS",
] as const;

/**
 * Removes the gateway launcher variables from the server's environment and returns them. Agents,
 * terminals, and provider SDKs all inherit that environment, so leaving them would hand every
 * agent the bridge token, and a dev server an agent starts would join the shared owner as a
 * standby runtime and take that role from this server.
 */
export const takeLauncherEnvironment = Effect.fn("HeadlessGatewayHost.takeLauncherEnvironment")(
  function* () {
    const env = yield* HostProcess.Environment;
    const taken: Record<string, string> = {};
    for (const key of LAUNCHER_ENV_KEYS) {
      const value = env[key];
      if (value === undefined) continue;
      taken[key] = value;
      delete env[key];
    }
    return taken;
  },
);

/** What `takeLauncherEnvironment` removed from the process environment at startup. */
class GatewayOwnerStartError extends Schema.TaggedError<GatewayOwnerStartError>()(
  "GatewayOwnerStartError",
  { cause: Schema.Defect() },
) {}

export class LauncherEnvironment extends Context.Service<
  LauncherEnvironment,
  Readonly<Record<string, string>>
>()("t3/mcp/agents/HeadlessGatewayHost/LauncherEnvironment") {}

const DEFAULT_SCOPES: ReadonlyArray<GatewayScope> = ["read", "delivery"];

/**
 * Opt-in, because the desktop app normally hosts the gateway runtime. The process environment
 * wins over the env file, so a unit or shell can override one value without editing the file.
 */
export function resolveHeadlessGatewaySettings(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly file: Readonly<Record<string, string>>;
  readonly homeDirectory: string;
  readonly baseDir: string;
  readonly mode: ServerConfig.ServerConfig["Service"]["mode"];
}): HeadlessGatewaySettings {
  const env = { ...input.file, ...stripUndefined(input.env) };
  const flag = env.T3_MCP_HEADLESS_GATEWAY?.trim().toLowerCase();
  if (flag !== "1" && flag !== "true") {
    return { enabled: false, reason: "T3_MCP_HEADLESS_GATEWAY is not set." };
  }
  // The desktop app's renderer is this server's gateway runtime.
  if (input.mode === "desktop") {
    return { enabled: false, reason: "The desktop app hosts the gateway runtime." };
  }
  const rawScopes = (env.T3_MCP_HEADLESS_SCOPES ?? DEFAULT_SCOPES.join(","))
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope !== "");
  const unknown = rawScopes.filter(
    (scope) => !GATEWAY_SCOPE_VALUES.includes(scope as GatewayScope),
  );
  if (unknown.length > 0) {
    return {
      enabled: false,
      reason: `T3_MCP_HEADLESS_SCOPES has unknown scopes: ${unknown.join(", ")}.`,
    };
  }
  const scopes = [...new Set(rawScopes)] as ReadonlyArray<GatewayScope>;
  if (!scopes.includes("read")) {
    return { enabled: false, reason: "T3_MCP_HEADLESS_SCOPES must include read." };
  }
  try {
    // Launchers find the owner's store under the server's T3 home, as the desktop's do.
    const config = sharedGatewayConfigFromEnvironment(
      { ...env, T3CODE_HOME: env.T3CODE_HOME ?? input.baseDir },
      input.homeDirectory,
    );
    return { enabled: true, config, scopes };
  } catch (error) {
    return { enabled: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function stripUndefined(env: Readonly<Record<string, string | undefined>>) {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

const readGatewayEnvFile = Effect.fn("HeadlessGatewayHost.readEnvFile")(function* (
  homeDirectory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(homeDirectory, ...GATEWAY_ENV_FILE);
  const info = yield* fileSystem.stat(file).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "File") return {};
  const uid = Option.getOrUndefined(info.value.uid);
  // The file holds the bridge token; like the desktop, ignore it unless only its owner can read it.
  if ((info.value.mode & 0o077) !== 0 || (uid !== undefined && uid !== process.getuid?.())) {
    yield* Effect.logWarning(`Ignoring ${file}: it must be owned by you with mode 0600.`);
    return {};
  }
  return parseGatewayEnvFile(yield* fileSystem.readFileString(file));
});

/** Headless thread events and signed webhooks need a gateway runtime without a desktop app.
 * Acquire the free bridge port or join its owner; stay standby while a desktop owns runtime.
 * One owner, store and delivery worker prevent duplicate delivery. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const launcherEnvironment = yield* LauncherEnvironment;
    const processEnvironment = yield* HostProcess.Environment;
    const homeDirectory = processEnvironment.HOME ?? "";
    const settings = resolveHeadlessGatewaySettings({
      env: { ...processEnvironment, ...launcherEnvironment },
      file: homeDirectory === "" ? {} : yield* readGatewayEnvFile(homeDirectory),
      homeDirectory,
      baseDir: config.baseDir,
      mode: config.mode,
    });
    if (!settings.enabled) {
      if (settings.reason !== "T3_MCP_HEADLESS_GATEWAY is not set.") {
        yield* Effect.logWarning(`Headless T3 Agents gateway is off: ${settings.reason}`);
      }
      return;
    }
    const local = yield* LocalGatewayPort.LocalGatewayPort;
    const gateway = settings.config;
    let owner: { readonly close: () => Promise<void> } | undefined;
    let closed = false;
    const holdOwner = Effect.gen(function* () {
      if (owner !== undefined || closed) return;
      // Undefined while another owner (a desktop app's) holds the port.
      const started = yield* Effect.tryPromise({
        try: () => startSharedGatewayOwner(gateway),
        catch: (cause) => new GatewayOwnerStartError({ cause }),
      }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Headless T3 Agents gateway owner failed to start.", { error }),
        ),
        Effect.orElseSucceed(() => undefined),
      );
      if (started === undefined) return;
      if (closed) yield* Effect.promise(() => started.close());
      else owner = started;
    });
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        closed = true;
        await owner?.close();
      }),
    );
    yield* forkParked(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            connectGatewayBridge({
              port: local.port,
              events: local.events,
              grants: { [local.environmentId]: settings.scopes },
              url: `ws://127.0.0.1:${gateway.port}`,
              token: gateway.token,
              standby: true,
              reconnectDelayMs: 5_000,
            }),
          ),
          (bridge) => Effect.sync(() => bridge.stop()),
        );
        yield* Effect.logInfo(
          `Headless T3 Agents gateway runtime on 127.0.0.1:${gateway.port} for ${local.environmentId} (${settings.scopes.join(", ")}).`,
        );
        // Take over the owner role whenever a desktop app's owner exits and frees the port.
        yield* holdOwner.pipe(Effect.repeat(Schedule.spaced("15 seconds")));
      }),
    );
  }),
);
