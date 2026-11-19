import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { EngineState, EngineTokenResult } from "../src/connection/engineState";
import { type LinuxHost, shellQuote } from "./wslEngine";

export interface EngineConfig {
  /** `AGENT_BOARD_ENGINE_URL`. */
  readonly engineUrl: string | undefined;
  /** `AGENT_BOARD_TOKEN`, a bearer for `engineUrl`. */
  readonly envToken: string | undefined;
  /** `AGENT_BOARD_T3_HOME`, a Linux path that replaces `~/.t3`. */
  readonly t3Home: string | undefined;
  /** `AGENT_BOARD_T3_CLI`, a shell command that replaces the discovered `t3`. */
  readonly t3Cli: string | undefined;
  /** The WSL distro, which scopes saved tokens: each distro has its own engine and sessions. */
  readonly distro: string | undefined;
}

export interface TokenStore {
  readonly read: (key: string) => string | null;
  readonly write: (key: string, token: string) => void;
}

export type Question = "install" | "update";

export interface EngineDeps {
  readonly config: EngineConfig;
  readonly host: Pick<LinuxHost, "exec" | "shell">;
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  readonly tokens: TokenStore;
  /** Whether the release a `--version` line reports connects to this client. */
  readonly runtimeCompatible: (versionText: string) => boolean;
  /** Asks the user once; declining leaves the app offline. */
  readonly confirm: (question: Question) => Promise<boolean>;
  readonly log: (message: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface Engine {
  readonly state: () => EngineState;
  readonly subscribe: (listener: (state: EngineState) => void) => () => void;
  readonly start: () => Promise<void>;
  /** A bearer the engine accepts right now, reissued once when the saved one is rejected. */
  readonly token: () => Promise<EngineTokenResult>;
}

const TOKEN_ARGS = "auth session issue --token-only --label agent-board --ttl 30d";
const INSTALL_COMMAND = "curl -fsSL https://t3.codes/install.sh | sh";
const SERVICE_ATTEMPTS = 90;
const SERVICE_ATTEMPT_MS = 1_000;
const COMMAND_TIMEOUT_MS = 300_000;

const RuntimeRecord = Schema.Struct({ pid: Schema.Int, origin: Schema.String });
const decodeRuntimeRecord = Schema.decodeOption(Schema.fromJsonString(RuntimeRecord));
const decodeDescriptor = Schema.decodeUnknownOption(
  Schema.Struct({ environmentId: Schema.String, serverVersion: Schema.String }),
);
const decodeSession = Schema.decodeUnknownOption(Schema.Struct({ authenticated: Schema.Boolean }));

/** The release number in a `t3 --version` line. */
const releaseOf = (line: string): string => /\d+\.\d+\.\d+\S*/.exec(line)?.[0] ?? line.trim();

interface RunningEngine {
  readonly origin: string;
  readonly version: string;
}

interface Cli {
  readonly command: string;
  readonly version: string;
}

/**
 * Reaches T3's own engine, the background service in WSL. The app never runs an engine of its
 * own and never stops one: it joins, asks T3 to start its service, installs T3, or updates it.
 */
export function createEngine(deps: EngineDeps): Engine {
  const { config, host, tokens, log } = deps;
  const listeners = new Set<(state: EngineState) => void>();
  let current: EngineState = { phase: "connecting" };
  let origin: string | null = null;
  let tokenKey = "";

  const setState = (next: EngineState) => {
    current = next;
    for (const listener of listeners) listener(next);
  };
  const offline = (reason: string) => {
    log(`engine offline: ${reason}`);
    setState({ phase: "offline", reason });
  };
  const ready = (readyOrigin: string) => {
    origin = readyOrigin;
    log(`engine ready at ${readyOrigin}`);
    setState({ phase: "ready", origin: readyOrigin });
  };

  // The script prelude names the T3 home once, so every command agrees on where state lives.
  // dev:windows forwards VITE_DEV_SERVER_URL into WSL, and T3 reads it as a switch to its dev state dir.
  const prelude = [
    "unset VITE_DEV_SERVER_URL",
    config.t3Home === undefined ? `T3_HOME="$HOME/.t3"` : `T3_HOME=${shellQuote(config.t3Home)}`,
  ].join("\n");
  const baseDirArg = config.t3Home === undefined ? "" : `--base-dir "$T3_HOME"`;
  const runtimeFile = `"$T3_HOME/userdata/server-runtime.json"`;

  const describe = async (candidate: string): Promise<string | null> => {
    try {
      const response = await deps.fetch(`${candidate}/.well-known/t3/environment`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) return null;
      const descriptor = decodeDescriptor(await response.json());
      return Option.isSome(descriptor) ? descriptor.value.serverVersion : null;
    } catch {
      return null;
    }
  };

  // The engine T3 runs for this home, when its recorded process is alive and its origin answers.
  const findEngine = async (): Promise<RunningEngine | null> => {
    const file = await host.shell(`${prelude}\ncat ${runtimeFile} 2>/dev/null\n`);
    const record = file.exitCode === 0 ? Option.getOrNull(decodeRuntimeRecord(file.stdout)) : null;
    if (record === null) return null;
    const alive = await host.exec(["test", "-d", `/proc/${record.pid}`]);
    if (alive.exitCode !== 0) {
      log(`server-runtime.json names pid ${record.pid}, which is gone`);
      return null;
    }
    const version = await describe(record.origin);
    return version === null ? null : { origin: record.origin, version };
  };

  const discoverCli = async (): Promise<Cli | null> => {
    const result = await host.shell(
      [
        prelude,
        `if command -v t3 >/dev/null 2>&1; then printf 'cli:t3|%s\\n' "$(t3 --version 2>/dev/null | head -n 1)"; fi`,
        `if [ -x "$HOME/.local/bin/t3" ]; then printf 'cli:%s|%s\\n' "$HOME/.local/bin/t3" "$("$HOME/.local/bin/t3" --version 2>/dev/null | head -n 1)"; fi`,
        `true`,
      ].join("\n"),
      { loginPath: true },
    );
    for (const line of result.stdout.split("\n")) {
      const match = /^cli:(.*)\|(.*?)\r?$/.exec(line);
      if (match?.[1] === undefined || match[2] === undefined || match[2].trim() === "") continue;
      return { command: shellQuote(match[1]), version: releaseOf(match[2]) };
    }
    return null;
  };

  const resolveCli = async (): Promise<Cli | null> =>
    config.t3Cli === undefined
      ? discoverCli()
      : { command: config.t3Cli, version: await overrideVersion(config.t3Cli) };

  const overrideVersion = async (command: string): Promise<string> => {
    const result = await host.shell(`${prelude}\n${command} --version 2>/dev/null | head -n 1\n`, {
      loginPath: true,
    });
    return releaseOf(result.stdout);
  };

  const run = async (script: string, what: string): Promise<void> => {
    const result = await host.shell(`${prelude}\n${script}\n`, {
      loginPath: true,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new Error(`${what} failed: ${(result.stderr || result.stdout).trim().slice(-300)}`);
    }
  };

  // The service restarts while it installs or updates, so joining polls until it answers.
  const joinService = async (): Promise<void> => {
    for (let attempt = 0; attempt < SERVICE_ATTEMPTS; attempt += 1) {
      const engine = await findEngine();
      if (engine !== null) {
        if (deps.runtimeCompatible(engine.version)) return ready(engine.origin);
        return offline(`T3 in WSL is ${engine.version}, which is too old for this app.`);
      }
      await deps.sleep(SERVICE_ATTEMPT_MS);
    }
    offline("T3's service in WSL did not start.");
  };

  const startService = async (cli: Cli): Promise<void> => {
    setState({ phase: "starting" });
    await run(`${cli.command} service install ${baseDirArg} </dev/null`, "t3 service install");
    await joinService();
  };

  const installT3 = async (): Promise<void> => {
    setState({ phase: "install-needed" });
    if (!(await deps.confirm("install"))) {
      return offline("T3 is not installed in WSL. Installing it was declined.");
    }
    setState({ phase: "installing" });
    await run(`export T3CODE_HOME="$T3_HOME"\n${INSTALL_COMMAND}`, "The T3 install script");
    const cli = await resolveCli();
    if (cli === null) throw new Error("T3 was installed but `t3` was not found in WSL.");
    await run(`${cli.command} service install ${baseDirArg} </dev/null`, "t3 service install");
    await joinService();
  };

  const updateT3 = async (found: string, cli: Cli | null): Promise<void> => {
    if (cli === null) return installT3();
    setState({ phase: "update-needed", found });
    if (!(await deps.confirm("update"))) {
      return offline(
        `T3 in WSL is ${found}, which is too old for this app. Updating was declined.`,
      );
    }
    setState({ phase: "updating" });
    await run(`${cli.command} update --yes ${baseDirArg} </dev/null`, "t3 update");
    // `t3 update` restarts only a service that is installed, so this also starts one that is not.
    const updated = (await resolveCli()) ?? cli;
    await run(`${updated.command} service install ${baseDirArg} </dev/null`, "t3 service install");
    await joinService();
  };

  const discover = async (): Promise<void> => {
    const engine = await findEngine();
    if (engine !== null && deps.runtimeCompatible(engine.version)) return ready(engine.origin);
    const cli = await resolveCli();
    if (engine !== null) return updateT3(engine.version, cli);
    if (cli === null) return installT3();
    if (!deps.runtimeCompatible(cli.version)) return updateT3(cli.version, cli);
    return startService(cli);
  };

  const mint = async (): Promise<string> => {
    const cli = await resolveCli();
    if (cli === null) throw new Error("T3 is not installed in WSL.");
    const result = await host.shell(`${prelude}\n${cli.command} ${TOKEN_ARGS} ${baseDirArg}\n`, {
      loginPath: true,
    });
    const token = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .findLast((line) => line.length > 0);
    if (result.exitCode !== 0 || token === undefined) {
      throw new Error(`Could not issue a token: ${result.stderr.trim() || "no output"}`);
    }
    tokens.write(tokenKey, token);
    return token;
  };

  // /api/auth/session answers 200 with authenticated:false for a revoked token.
  const accepted = async (bearer: string): Promise<boolean> => {
    const response = await deps.fetch(`${origin}/api/auth/session`, {
      headers: { authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 401) return false;
    if (!response.ok) throw new Error(`The engine answered ${response.status} to a session check.`);
    const session = decodeSession(await response.json());
    return Option.isSome(session) && session.value.authenticated;
  };

  let issuing: Promise<EngineTokenResult> | null = null;
  const issueToken = async (): Promise<EngineTokenResult> => {
    if (origin === null) return { ok: false, error: "unavailable", detail: "No engine yet." };
    try {
      let candidate = config.envToken ?? tokens.read(tokenKey);
      // The second pass is the single reissue after a rejection.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        candidate ??= await mint();
        if (await accepted(candidate)) return { ok: true, token: candidate };
        log(attempt === 0 ? "token rejected, reissuing" : "reissued token rejected");
        candidate = null;
      }
      return {
        ok: false,
        error: "auth_failed",
        detail: "The engine rejected a freshly issued token.",
      };
    } catch (error) {
      return {
        ok: false,
        error: "unavailable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  };

  return {
    state: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    start: async () => {
      setState({ phase: "connecting" });
      try {
        if (config.engineUrl !== undefined) {
          const url = new URL(config.engineUrl).origin;
          tokenKey = `url:${url}`;
          return (await describe(url)) !== null
            ? ready(url)
            : offline(`AGENT_BOARD_ENGINE_URL ${url} does not answer.`);
        }
        tokenKey = `${config.distro ?? "default"}:home:${config.t3Home ?? "~/.t3"}`;
        await discover();
      } catch (error) {
        offline(error instanceof Error ? error.message : String(error));
      }
    },
    token: () => (issuing ??= issueToken().finally(() => (issuing = null))),
  };
}
