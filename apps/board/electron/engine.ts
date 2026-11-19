import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { EngineRoute, EngineState, EngineTokenResult } from "../src/connection/engineState";
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
}

export interface TokenStore {
  readonly read: (key: string) => string | null;
  readonly write: (key: string, token: string) => void;
}

export interface EngineDeps {
  readonly config: EngineConfig;
  readonly host: LinuxHost;
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  readonly tokens: TokenStore;
  /** Whether the release a `--version` line reports connects to this client. */
  readonly runtimeCompatible: (versionText: string) => boolean;
  /** Asks once whether to install the current T3 release in WSL. */
  readonly confirmInstall: () => Promise<boolean>;
  readonly log: (message: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface Engine {
  readonly state: () => EngineState;
  readonly subscribe: (listener: (state: EngineState) => void) => () => void;
  readonly start: () => Promise<void>;
  /** A bearer the engine accepts right now, reissued once when the saved one is rejected. */
  readonly token: () => Promise<EngineTokenResult>;
  /** Stops the engine this app booted. An engine it joined keeps running. */
  readonly stop: () => Promise<void>;
}

// Matches SERVER_EXIT_CODE_STATE_DIR_OWNED in @t3tools/contracts, which the board does not import at runtime.
const STATE_DIR_OWNED_EXIT_CODE = 78;
const TOKEN_ARGS = "auth session issue --token-only --label agent-board --ttl 30d";
const INSTALL_COMMAND = "curl -fsSL https://t3.codes/install.sh | sh";
const BOOT_WAIT_SECONDS = 30;
const ORIGIN_ATTEMPTS = 50;
const JOIN_AFTER_OWNED_ATTEMPTS = 20;
const STOP_GRACE_MS = 4_000;

const RuntimeRecord = Schema.Struct({ pid: Schema.Int, origin: Schema.String });
const decodeRuntimeRecord = Schema.decodeOption(Schema.fromJsonString(RuntimeRecord));
const parseRuntimeRecord = (text: string): typeof RuntimeRecord.Type | null =>
  Option.getOrNull(decodeRuntimeRecord(text));
const decodeDescriptor = Schema.decodeUnknownOption(
  Schema.Struct({ environmentId: Schema.String }),
);
const decodeSession = Schema.decodeUnknownOption(Schema.Struct({ authenticated: Schema.Boolean }));

export function createEngine(deps: EngineDeps): Engine {
  const { config, host, tokens, log } = deps;
  const listeners = new Set<(state: EngineState) => void>();
  let current: EngineState = { phase: "connecting" };
  let origin: string | null = null;
  let tokenKey = "";
  let cli: string | null = null;
  let booted: { readonly pid: number; readonly exited: Promise<number | null> } | null = null;
  let stopping = false;
  const tooOld: string[] = [];

  const setState = (next: EngineState) => {
    current = next;
    for (const listener of listeners) listener(next);
  };
  const offline = (reason: string) => {
    log(`engine offline: ${reason}`);
    setState({ phase: "offline", reason });
  };
  const ready = (route: EngineRoute, readyOrigin: string) => {
    origin = readyOrigin;
    log(`engine ready (${route}) at ${readyOrigin}`);
    setState({ phase: "ready", route, origin: readyOrigin });
  };

  // The script prelude names the T3 home once, so every command agrees on where state lives.
  const prelude =
    config.t3Home === undefined ? `T3_HOME="$HOME/.t3"` : `T3_HOME=${shellQuote(config.t3Home)}`;
  const baseDirArg = config.t3Home === undefined ? "" : `--base-dir "$T3_HOME"`;
  const runtimeFile = `"$T3_HOME/userdata/server-runtime.json"`;

  const answers = async (candidate: string): Promise<boolean> => {
    try {
      const response = await deps.fetch(`${candidate}/.well-known/t3/environment`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) return false;
      return Option.isSome(decodeDescriptor(await response.json()));
    } catch {
      return false;
    }
  };

  const waitForOrigin = async (candidate: string, attempts: number): Promise<boolean> => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await answers(candidate)) return true;
      await deps.sleep(200);
    }
    return false;
  };

  const readRuntimeRecord = async (): Promise<typeof RuntimeRecord.Type | null> => {
    const result = await host.shell(`${prelude}\ncat ${runtimeFile} 2>/dev/null\n`);
    return result.exitCode === 0 ? parseRuntimeRecord(result.stdout) : null;
  };

  const tryJoin = async (): Promise<boolean> => {
    const record = await readRuntimeRecord();
    if (record === null) return false;
    const alive = await host.exec(["test", "-d", `/proc/${record.pid}`]);
    if (alive.exitCode !== 0) {
      log(`server-runtime.json names pid ${record.pid}, which is gone`);
      return false;
    }
    if (!(await answers(record.origin))) return false;
    ready("joined", record.origin);
    return true;
  };

  // Runtimes this client can use, best first: `t3` from the login PATH, then staged runtimes by
  // age. A candidate that prints no version, such as a stub, never counts.
  const discoverCli = async (): Promise<string | null> => {
    if (config.t3Cli !== undefined) return config.t3Cli;
    const result = await host.shell(
      [
        prelude,
        `if command -v t3 >/dev/null 2>&1; then printf 'cli:t3|%s\\n' "$(t3 --version 2>/dev/null | head -n 1)"; fi`,
        `if [ -x "$HOME/.local/bin/t3" ]; then printf 'cli:%s|%s\\n' "$HOME/.local/bin/t3" "$("$HOME/.local/bin/t3" --version 2>/dev/null | head -n 1)"; fi`,
        `for d in $(ls -1t "$T3_HOME/wsl-runtime" 2>/dev/null); do`,
        `  e="$T3_HOME/wsl-runtime/$d/apps/server/dist/bin.mjs"`,
        `  [ -f "$e" ] && printf 'node:%s|%s\\n' "$e" "$(node "$e" --version 2>/dev/null | head -n 1)"`,
        `done`,
        `true`,
      ].join("\n"),
      { loginPath: true },
    );
    for (const line of result.stdout.split("\n")) {
      const match = /^(cli|node):(.*)\|(.*?)\r?$/.exec(line);
      if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) continue;
      if (match[3].trim() === "") continue;
      if (!deps.runtimeCompatible(match[3])) {
        tooOld.push(/\d+\.\d+\.\d+\S*/.exec(match[3])?.[0] ?? match[3].trim());
        continue;
      }
      return match[1] === "cli" ? shellQuote(match[2]) : `node ${shellQuote(match[2])}`;
    }
    return null;
  };

  const ensureCli = async (): Promise<string | null> => {
    cli ??= await discoverCli();
    if (cli !== null) return cli;
    setState({ phase: "install-needed" });
    if (!(await deps.confirmInstall())) return null;
    setState({ phase: "starting" });
    const installed = await host.shell(
      `${prelude}\nexport T3CODE_HOME="$T3_HOME"\n${INSTALL_COMMAND}\n`,
      { loginPath: true, timeoutMs: 300_000 },
    );
    if (installed.exitCode !== 0) {
      throw new Error(`The T3 install script failed: ${installed.stderr.trim() || "no output"}`);
    }
    cli = await discoverCli();
    if (cli === null) throw new Error("The installed T3 does not work with this app.");
    return cli;
  };

  const bootEngine = async (): Promise<void> => {
    setState({ phase: "starting" });
    const command = await ensureCli();
    if (command === null) {
      const found = tooOld.length === 0 ? "" : ` Found ${[...new Set(tooOld)].join(", ")}.`;
      return offline(
        `T3 in WSL is too old or missing.${found} Installing the current release was declined.`,
      );
    }
    const child = await host.start(
      [
        prelude,
        `echo "pid:$$"`,
        `exec ${command} serve --no-browser ${baseDirArg} </dev/null 2>&1`,
      ].join("\n"),
      { loginPath: true },
    );
    const pidLine = await child.firstLine;
    const pid = pidLine?.startsWith("pid:") ? Number(pidLine.slice(4)) : Number.NaN;
    if (!Number.isInteger(pid)) {
      await child.exited;
      return offline(`Could not start the engine: ${child.output().trim().slice(-300)}`);
    }
    booted = { pid, exited: child.exited };
    log(`booted engine pid ${pid}`);
    void child.exited.then((exitCode) => {
      if (stopping || booted?.pid !== pid) return;
      booted = null;
      if (exitCode === STATE_DIR_OWNED_EXIT_CODE) return;
      offline(`The engine exited with code ${exitCode}: ${child.output().trim().slice(-300)}`);
    });

    const waited = await host.shell(
      [
        prelude,
        `i=0`,
        `while [ $i -lt ${BOOT_WAIT_SECONDS * 5} ]; do`,
        `  if grep -q "\\"pid\\":${pid}[,}]" ${runtimeFile} 2>/dev/null; then cat ${runtimeFile}; exit 0; fi`,
        `  kill -0 ${pid} 2>/dev/null || exit 2`,
        `  sleep 0.2; i=$((i+1))`,
        `done`,
        `exit 1`,
      ].join("\n"),
      { timeoutMs: (BOOT_WAIT_SECONDS + 5) * 1_000 },
    );
    const record = waited.exitCode === 0 ? parseRuntimeRecord(waited.stdout) : null;
    if (record === null) {
      const exitCode = await Promise.race([child.exited, deps.sleep(1_000).then(() => undefined)]);
      if (exitCode === STATE_DIR_OWNED_EXIT_CODE) return joinAfterOwned();
      if (booted?.pid === pid) {
        booted = null;
        void host.exec(["kill", "-TERM", String(pid)]);
      }
      return offline(
        `The engine did not start: ${child.output().trim().slice(-300) || "no output"}`,
      );
    }
    if (!(await waitForOrigin(record.origin, ORIGIN_ATTEMPTS))) {
      return offline(`The engine started but ${record.origin} does not answer.`);
    }
    ready("booted", record.origin);
  };

  // Another engine took the state folder between the join probe and the boot.
  const joinAfterOwned = async (): Promise<void> => {
    for (let attempt = 0; attempt < JOIN_AFTER_OWNED_ATTEMPTS; attempt += 1) {
      if (await tryJoin()) return;
      await deps.sleep(500);
    }
    offline("Another engine owns the T3 state folder but does not answer.");
  };

  const mint = async (): Promise<string> => {
    const command = await ensureCli();
    if (command === null) throw new Error("T3 is not installed in WSL.");
    const result = await host.shell(`${prelude}\n${command} ${TOKEN_ARGS} ${baseDirArg}\n`, {
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
          return (await answers(url))
            ? ready("env", url)
            : offline(`AGENT_BOARD_ENGINE_URL ${url} does not answer.`);
        }
        tokenKey = `home:${config.t3Home ?? "~/.t3"}`;
        if (!(await tryJoin())) await bootEngine();
      } catch (error) {
        offline(error instanceof Error ? error.message : String(error));
      }
    },
    token: () => (issuing ??= issueToken().finally(() => (issuing = null))),
    stop: async () => {
      if (booted === null) return;
      stopping = true;
      const { pid, exited } = booted;
      booted = null;
      await host.exec(["kill", "-TERM", String(pid)]);
      const settled = await Promise.race([exited, deps.sleep(STOP_GRACE_MS).then(() => "timeout")]);
      if (settled === "timeout") await host.exec(["kill", "-KILL", String(pid)]);
    },
  };
}
